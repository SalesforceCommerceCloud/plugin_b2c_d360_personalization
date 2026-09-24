'use strict';

/**
 * Rough starter implementation of the "decouple to product-ID-only, render live via SCAPI"
 * pattern: Salesforce Personalization returns product IDs for shopper context, this file
 * hydrates them with live price/promo/availability from B2C Commerce SCAPI, then clones the
 * storefront's existing product-tile template rather than inventing new markup.
 *
 * Known gaps to close before this is production-ready (intentionally left rough):
 *   - Token flow below is the anonymous/guest SLAS grant. Logged-in shopper pricing (assigned
 *     promotions, customer groups) needs the real shopper JWT this storefront already manages,
 *     not a fresh guest token.
 *   - No retry/backoff, no batching beyond SCAPI's 24-id-per-call limit.
 */
(function () {
    // Guest-only SLAS token, readable by any script on the page (sessionStorage isn't
    // origin-isolated from other same-origin JS) — accepted risk since it grants no more
    // than anonymous SCAPI access; do not reuse this storage for a real shopper JWT.
    var TOKEN_STORAGE_KEY = 'ps_slasToken';
    var MAX_IDS_PER_CALL = 24;
    var FETCH_TIMEOUT_MS = 8000;

    // In-flight token request, shared across all zones on the page so a cold cache
    // doesn't fire one SLAS token POST per zone (see getShopperToken()).
    var pendingTokenRequest = null;

    // Every fetch in this file is a hard dependency (config, token, product data) with no
    // retry — without a timeout, a hung connection leaves a zone permanently empty/loading.
    function fetchWithTimeout(url, options) {
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var opts = options || {};
        if (controller) opts.signal = controller.signal;

        var timeoutId = controller && setTimeout(function () {
            controller.abort();
        }, FETCH_TIMEOUT_MS);

        return fetch(url, opts).then(function (res) {
            if (timeoutId) clearTimeout(timeoutId);
            return res;
        }, function (error) {
            if (timeoutId) clearTimeout(timeoutId);
            throw error;
        });
    }

    function getCachedToken() {
        try {
            var raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            return (typeof parsed.expiresAt === 'number' && parsed.expiresAt > Date.now())
                ? parsed.accessToken
                : null;
        } catch (e) {
            return null;
        }
    }

    function cacheToken(accessToken, expiresInSeconds) {
        var ttlSeconds = (typeof expiresInSeconds === 'number' && expiresInSeconds > 60)
            ? expiresInSeconds
            : 300;
        try {
            sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({
                accessToken: accessToken,
                expiresAt: Date.now() + (ttlSeconds - 60) * 1000
            }));
        } catch (e) { /* sessionStorage unavailable — token simply won't be cached */ }
    }

    // ps_scapiClientId is a public (PKCE) SLAS client with no secret, so the token can't be
    // minted with a client_credentials POST from here — that flow is private-client-only.
    // The actual PKCE authorize/token exchange happens server-side (GetToken endpoint, see
    // scripts/personalization/slasGuestToken.js); this just fetches the result same-origin.
    function requestShopperToken(config) {
        return fetchWithTimeout(config.getTokenUrl)
            .then(function (res) {
                if (!res.ok) throw new Error('SLAS token request failed: ' + res.status);
                return res.json();
            })
            .then(function (data) {
                cacheToken(data.accessToken, data.expiresIn);
                return data.accessToken;
            });
    }

    function getShopperToken(config) {
        var cached = getCachedToken();
        if (cached) return Promise.resolve(cached);

        if (!pendingTokenRequest) {
            pendingTokenRequest = requestShopperToken(config)
                .then(function (token) {
                    pendingTokenRequest = null;
                    return token;
                }, function (error) {
                    pendingTokenRequest = null;
                    throw error;
                });
        }
        return pendingTokenRequest;
    }

    // Loads the tenant-specific Data Cloud/Salesforce Interactions beacon SDK (exposes
    // window.getSalesforceInteractions()) at most once per page, shared across all zones.
    var sdkLoadPromise = null;
    var SDK_READY_TIMEOUT_MS = 8000;
    var SDK_READY_POLL_MS = 100;

    // The beacon SDK registers window.getSalesforceInteractions() asynchronously — it is
    // typically NOT present the instant the <script> onload fires. Poll (bounded) until the
    // global appears so callers don't race the SDK's own init and hit the "not found" branch.
    function waitForSdkReady() {
        return new Promise(function (resolve) {
            if (typeof window.getSalesforceInteractions === 'function') {
                resolve();
                return;
            }
            var waited = 0;
            var timer = setInterval(function () {
                if (typeof window.getSalesforceInteractions === 'function') {
                    clearInterval(timer);
                    resolve();
                } else if (waited >= SDK_READY_TIMEOUT_MS) {
                    clearInterval(timer);
                    console.warn('[PersonalizationTiles] Data Cloud SDK did not expose getSalesforceInteractions() within '
                        + SDK_READY_TIMEOUT_MS + 'ms — proceeding; the decision call will report if it is still unavailable.');
                    resolve();
                }
                waited += SDK_READY_POLL_MS;
            }, SDK_READY_POLL_MS);
        });
    }

    function ensureDcSdkLoaded(sdkUrl) {
        if (typeof window.getSalesforceInteractions === 'function') return Promise.resolve();
        if (!sdkUrl) return Promise.resolve();
        if (!sdkLoadPromise) {
            sdkLoadPromise = new Promise(function (resolve) {
                var script = document.createElement('script');
                script.src = sdkUrl;
                script.async = true;
                script.onload = function () { resolve(); };
                script.onerror = function () {
                    console.error('[PersonalizationTiles] Failed to load Data Cloud SDK script: ' + sdkUrl);
                    resolve();
                };
                document.head.appendChild(script);
            });
        }
        // Resolve only once the SDK global is actually usable, not merely when the file loaded.
        return sdkLoadPromise.then(waitForSdkReady);
    }

    // Fires a single "personalization-view" or "personalization-click" activity event on the
    // Salesforce Interactions SDK for one rendered tile. Gated on ps_activityTrackingEnabled
    // (config.activityTrackingEnabled) so a customer can turn tracking off independently of the
    // tile feature itself; falls back to a no-op (not an error) when the SDK hasn't loaded —
    // e.g. ps_dcSdkUrl unset — same tolerance as getPersonalizationDecisions() above.
    function sendPersonalizationEvent(eventName, config, personalizationId, personalizationContentId, productId) {
        if (!config.activityTrackingEnabled || !productId) return;

        if (typeof window.getSalesforceInteractions !== 'function') return;
        var interactions = window.getSalesforceInteractions();
        if (!interactions || typeof interactions.sendEvent !== 'function') return;

        try {
            interactions.sendEvent({
                interaction: {
                    name: eventName,
                    eventType: 'catalog',
                    personalizationId: personalizationId,
                    personalizationContentId: personalizationContentId,
                    id: productId,
                    type: 'Product'
                }
            });
        } catch (error) {
            console.error('[PersonalizationTiles] sendEvent("' + eventName + '") failed for product id "' + productId + '":', error);
        }
    }

    // pointNames is the deduped list of every personalization point referenced by a
    // [data-ps-point] container on the page — one Personalization.fetch() call covers all of
    // them so a page with several slots (plain includes and/or Page Designer instances) never
    // fires more than one decision call. productIdField is the field on each returned item
    // that carries the product id (varies by customer implementation, e.g. "ssot__Id__c").
    function getPersonalizationDecisions(pointNames, productIdField) {
        if (!pointNames.length) return Promise.resolve({});

        if (typeof window.getSalesforceInteractions !== 'function') {
            console.warn('[PersonalizationTiles] getSalesforceInteractions() not found — verify the Data Cloud SDK script loaded for personalization points: '
                + pointNames.join(', '));
            return Promise.resolve({});
        }

        var interactions = window.getSalesforceInteractions();
        if (!interactions || !interactions.Personalization || typeof interactions.Personalization.fetch !== 'function') {
            console.warn('[PersonalizationTiles] Personalization.fetch() not available on the Salesforce Interactions SDK for personalization points: '
                + pointNames.join(', '));
            return Promise.resolve({});
        }

        // performance.now() (not Date.now()) brackets just the SDK call itself — network time
        // to Data Cloud plus the SDK's own response handling — so this number is directly
        // comparable to the GetToken/SCAPI/GetPrices stage timings in the request waterfall.
        var decisionFetchStart = window.performance && window.performance.now ? window.performance.now() : Date.now();

        return interactions.Personalization.fetch(pointNames)
            .then(function (response) {
                var decisionFetchEnd = window.performance && window.performance.now ? window.performance.now() : Date.now();
                // eslint-disable-next-line no-console
                console.log('[PersonalizationTiles] Data Cloud Personalization.fetch() took '
                    + Math.round(decisionFetchEnd - decisionFetchStart) + 'ms for personalization points: '
                    + pointNames.join(', '));

                var personalizations = (response && response.personalizations) || [];
                var decisionsByPoint = {};

                personalizations.forEach(function (personalization, index) {
                    // Match by name for robustness; fall back to array index only if the SDK
                    // response ever omits personalizationPointName.
                    var pointName = personalization.personalizationPointName || pointNames[index];
                    var items = personalization.data || [];

                    // console.log('...', items) prints a live, collapsed object reference in
                    // devtools — stringifying gives a copyable JSON text block instead.
                    // eslint-disable-next-line no-console
                    console.log('[PersonalizationTiles] Raw decision items (all attributes) for "'
                        + pointName + '":\n' + JSON.stringify(items, null, 2));

                    var productIds = items.map(function (item) {
                        return item[productIdField];
                    }).filter(Boolean);

                    // eslint-disable-next-line no-console
                    console.log('[PersonalizationTiles] Product IDs from Personalization engine for "'
                        + pointName + '":', productIds);

                    // personalizationId is unique per decision request/point and is required
                    // (alongside each item's personalizationContentId) on every activity-tracking
                    // sendEvent() call below — carried alongside items rather than folded into
                    // them since it's the same value for every item in this point's response.
                    decisionsByPoint[pointName] = {
                        personalizationId: personalization.personalizationId,
                        items: items
                    };
                });

                return decisionsByPoint;
            })
            .catch(function (error) {
                var decisionFetchEnd = window.performance && window.performance.now ? window.performance.now() : Date.now();
                console.error('[PersonalizationTiles] Personalization.fetch failed after '
                    + Math.round(decisionFetchEnd - decisionFetchStart) + 'ms for personalization points ['
                    + pointNames.join(', ') + ']:', error);
                return {};
            });
    }

    // Direct cross-origin fetch to SCAPI Shopper Products — the storefront's SLAS client is
    // now registered in this org's SCAPI CORS Preferences (client_id + site allow-list), so
    // this no longer needs to proxy through PersonalizationTiles-GetProducts.
    function fetchLiveProductData(productIds, config, token) {
        if (!productIds.length || !config.shortCode || !config.organizationId) return Promise.resolve([]);

        var url = 'https://' + config.shortCode + '.api.commercecloud.salesforce.com'
            + '/product/shopper-products/v1/organizations/' + config.organizationId + '/products'
            + '?ids=' + productIds.slice(0, MAX_IDS_PER_CALL).map(encodeURIComponent).join(',')
            + '&siteId=' + encodeURIComponent(config.siteId)
            + '&currency=' + encodeURIComponent(config.currency)
            + '&locale=' + encodeURIComponent(config.locale)
            + '&expand=' + encodeURIComponent(config.expand);

        return fetchWithTimeout(url, { headers: { Authorization: 'Bearer ' + token } })
            .then(function (res) {
                if (!res.ok) throw new Error('SCAPI product lookup failed: ' + res.status);
                return res.json();
            })
            .then(function (data) { return data.data || []; });
    }

    // SCAPI Shopper Products only ever returns one resolved price per product — it can't tell
    // a shopper-facing "list" price apart from a price-book markdown, so it can't drive the
    // list/sale strike-through the storefront's native product tiles show. This re-fetches
    // storefront-parity price HTML (same Script API pricing logic + template as Tile-Show)
    // same-origin, keyed by the same product ids already being hydrated from SCAPI. Failure
    // here must never block tile rendering — hydrateTile's SCAPI-derived price is left in place
    // as a fallback (see applyServerPrice below).
    function fetchServerPrices(productIds, config) {
        if (!productIds.length || !config.pricesUrl) return Promise.resolve({});

        var url = config.pricesUrl + '?ids=' + productIds.map(encodeURIComponent).join(',');
        return fetchWithTimeout(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function (res) {
                if (!res.ok) throw new Error('Price lookup failed: ' + res.status);
                return res.json();
            })
            .then(function (data) { return data.prices || {}; })
            .catch(function (error) {
                console.error('[PersonalizationTiles] Server-side price lookup failed:', error);
                return {};
            });
    }

    // Swaps the tile's price markup for server-rendered, storefront-parity HTML (list/sale
    // strike-through) when the lookup succeeded for this product id. Same-origin, server-
    // generated HTML (numbers/resource strings only, no raw catalog text) — safe to inject
    // directly, unlike the untrusted SCAPI catalog fields guarded by isSafeUrl() above.
    function applyServerPrice(tile, priceEntry) {
        if (!priceEntry || !priceEntry.rendered) return;
        var container = tile.querySelector('[data-ps-field="priceContainer"]');
        if (container) container.outerHTML = priceEntry.rendered;
    }

    function formatPrice(amount, currency, locale) {
        if (amount === undefined || amount === null) return '';
        try {
            return new Intl.NumberFormat(locale, { style: 'currency', currency: currency }).format(amount);
        } catch (e) {
            return currency + ' ' + amount;
        }
    }

    // SCAPI product data (c_productUrl, image links) originates from catalog/feed content,
    // not from a trusted first party — reject anything but http(s)/relative before it lands
    // in a DOM href/src sink, or a value like "javascript:..." becomes live XSS on click/load.
    function isSafeUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return /^https?:\/\//i.test(url) || url.charAt(0) === '/';
    }

    function hydrateTile(templateNode, product, config) {
        if (!product || !product.id) return null;

        // Out-of-stock SKUs come back as normal product objects (not null) with
        // inventory.orderable=false — skip them rather than render a dead tile.
        if (product.inventory && product.inventory.orderable === false) return null;

        var tile = templateNode.content.firstElementChild.cloneNode(true);
        tile.removeAttribute('id');
        tile.classList.remove('ps-tile-template');
        tile.setAttribute('data-pid', product.id);

        var fallbackUrl = config.productUrlTemplate
            ? config.productUrlTemplate.replace('PS_PID_PLACEHOLDER', encodeURIComponent(product.id))
            : '/on/demandware.store/Sites-' + config.siteId + '-Site/default/Product-Show?pid=' + product.id;
        var productUrl = isSafeUrl(product.c_productUrl) ? product.c_productUrl : fallbackUrl;
        var link = tile.querySelectorAll('[data-ps-field="link"]');
        Array.prototype.forEach.call(link, function (a) {
            a.href = productUrl;
        });

        var image = tile.querySelector('[data-ps-field="image"]');
        if (image && product.imageGroups && product.imageGroups[0] && product.imageGroups[0].images[0]) {
            var imageUrl = product.imageGroups[0].images[0].link;
            if (isSafeUrl(imageUrl)) {
                image.src = imageUrl;
                // Non-empty fallback so an image-only link (no visible text) still gets an
                // accessible name — an empty alt would make it invisible to screen readers.
                image.alt = product.imageGroups[0].images[0].alt || product.name || 'Product image';
            }
        }

        var name = tile.querySelector('[data-ps-field="name"]');
        if (name) name.textContent = product.name || '';

        var price = tile.querySelector('[data-ps-field="price"]');
        if (price) {
            // Immediate fallback from the SCAPI product response — no list/sale distinction.
            // Overwritten with server-rendered, storefront-parity price HTML once the
            // fetchServerPrices() lookup resolves (see renderZone / applyServerPrice), unless
            // that lookup failed or omitted this product id, in which case this stays.
            price.textContent = formatPrice(product.price, product.currency || config.currency, config.locale);
        }

        var promo = tile.querySelector('[data-ps-field="promo"]');
        if (promo) {
            var promoText = product.productPromotions && product.productPromotions[0] && product.productPromotions[0].calloutMsg;
            promo.textContent = promoText || '';
            promo.hidden = !promoText;
        }

        return tile;
    }

    // Placeholder tile for when SCAPI/SLAS isn't configured yet — lets a slot demonstrate the
    // Personalization decision -> point -> tile wiring end to end using only the product id,
    // ahead of wiring live SCAPI hydration once shopper token access is available.
    function hydrateMockTile(templateNode, productId) {
        var tile = templateNode.content.firstElementChild.cloneNode(true);
        tile.removeAttribute('id');
        tile.classList.remove('ps-tile-template');
        tile.classList.add('ps-tile-mock');
        tile.setAttribute('data-pid', productId);

        var links = tile.querySelectorAll('[data-ps-field="link"]');
        Array.prototype.forEach.call(links, function (a) {
            a.href = '#';
            a.setAttribute('aria-disabled', 'true');
        });

        var image = tile.querySelector('[data-ps-field="image"]');
        if (image) {
            image.removeAttribute('src');
            image.alt = 'Mock product ' + productId;
        }

        var name = tile.querySelector('[data-ps-field="name"]');
        if (name) name.textContent = 'Mock product ' + productId;

        var price = tile.querySelector('[data-ps-field="price"]');
        if (price) price.textContent = '';

        var promo = tile.querySelector('[data-ps-field="promo"]');
        if (promo) {
            promo.textContent = 'Preview — SCAPI not yet connected';
            promo.hidden = false;
        }

        return tile;
    }

    // Fetches the storefront's native, already-cached product tile fragment for each capped
    // product id (Tile-Show — the same controller/model/template native search grids use)
    // instead of hydrating via SCAPI. credentials: 'same-origin' carries the shopper's session
    // cookie so pricing reflects logged-in/customer-group/promotion state, not just guest
    // pricing. Each fetch is independently caught -> null so one bad/timed-out id never fails
    // the whole batch; Promise.all preserves input order, so tile order still matches the
    // personalization decision order.
    function fetchSfraTiles(productIds, config) {
        if (!productIds.length) return Promise.resolve([]);

        var requests = productIds.map(function (productId) {
            var url = config.tileUrlTemplate.replace('PS_PID_PLACEHOLDER', encodeURIComponent(productId));
            return fetchWithTimeout(url, {
                method: 'GET',
                credentials: 'same-origin',
                headers: { Accept: 'text/html' }
            })
                .then(function (res) {
                    if (!res.ok) throw new Error('Tile-Show failed: ' + res.status);
                    return res.text();
                })
                .catch(function (error) {
                    console.error('[PersonalizationTiles] Tile-Show fetch failed for product id "' + productId + '":', error);
                    return null;
                });
        });

        return Promise.all(requests);
    }

    // Tile-Show never 404s: an unknown/offline pid falls back to rendering gridTile.isml with
    // product=false, which prints <div class="product" data-pid="">...</div> (see Tile.js's
    // catch block and gridTile.isml) — an empty data-pid is how we detect and skip that
    // fallback, the same tile a native search grid would simply never have requested.
    function parseSfraTile(html) {
        if (!html) return null;
        var container = document.createElement('div');
        // Trusted, same-origin, ISML-encoded server output (our own Tile-Show controller) —
        // unlike the SCAPI path's catalog-origin URLs, this doesn't need isSafeUrl scheme
        // validation before landing in the DOM.
        container.innerHTML = html;
        var node = container.firstElementChild;
        if (!node || !node.classList.contains('product') || !node.getAttribute('data-pid')) return null;
        return node;
    }

    // Fires "personalization-view" for one just-rendered tile and stamps its
    // personalizationContentId onto the DOM so the zone's single delegated click listener
    // (see bindClickTracking below) can read it back later without re-threading decision
    // data through the click handler's closure.
    function trackRenderedTile(tile, config, personalizationId, entry) {
        if (!entry) return;
        tile.setAttribute('data-ps-personalization-content-id', entry.personalizationContentId || '');
        sendPersonalizationEvent('personalization-view', config, personalizationId, entry.personalizationContentId, entry.productId);
    }

    // Binds exactly once per row (guarded via a dataset flag, since row.innerHTML is replaced
    // on every re-render but the row element itself is not) — a single delegated listener
    // outlives every re-render instead of leaking one bound listener per tile per render pass.
    // Reads personalizationId/personalizationContentId/productId back off the DOM (zoneEl's
    // data-ps-personalization-id, the clicked tile's data-ps-personalization-content-id and
    // data-pid) rather than from closure state, since the tiles under this row are replaced
    // wholesale on every decision refresh.
    function bindClickTracking(zoneEl, row, config) {
        if (row.dataset.psClickBound) return;
        row.dataset.psClickBound = 'true';

        row.addEventListener('click', function (event) {
            var anchor = event.target.closest && event.target.closest('a');
            // .quickview opens a modal rather than navigating to the product — not a
            // personalization click-through.
            if (!anchor || anchor.classList.contains('quickview')) return;

            var tile = anchor.closest('[data-pid]');
            var productId = tile && tile.getAttribute('data-pid');
            if (!tile || !productId) return;

            var personalizationContentId = tile.getAttribute('data-ps-personalization-content-id');
            var personalizationId = zoneEl.getAttribute('data-ps-personalization-id');
            sendPersonalizationEvent('personalization-click', config, personalizationId, personalizationContentId, productId);
        });
    }

    // "sfra" render-mode counterpart to the scapi live-hydration branch in renderZone: same
    // wrapCarouselItem/finalizeCarousel/empty-zone handling, different tile source. entries is
    // capped's {productId, personalizationContentId} form — fetchSfraTiles/Promise.all preserve
    // input order, so fragments[index] always corresponds to entries[index].
    function renderSfraZone(zoneEl, config, entries, row, personalizationId) {
        var productIds = entries.map(function (entry) { return entry.productId; });
        return fetchSfraTiles(productIds, config).then(function (fragments) {
            row.innerHTML = '';
            var tileCount = 0;
            fragments.forEach(function (html, index) {
                var tile = parseSfraTile(html);
                if (tile) {
                    trackRenderedTile(tile, config, personalizationId, entries[index]);
                    row.appendChild(wrapCarouselItem(tile, tileCount === 0));
                    tileCount += 1;
                }
            });
            // Nothing to show (empty decision, all ids unresolved) — hide the zone rather
            // than leave a bare heading with no tiles beneath it.
            zoneEl.hidden = tileCount === 0;
            finalizeCarousel(zoneEl, tileCount);
        });
    }

    // assets.addCss can't reach this stylesheet (see productRecommendations.isml) since this
    // script runs from content that renders after the page head is already printed — inject
    // it once here instead. Guarded by a page-level flag plus an href check so N zones on one
    // page (each carrying their own window.psCarouselCssUrl script tag) only add it once.
    var carouselCssInjected = false;
    function ensureCarouselCssLoaded() {
        if (carouselCssInjected) return;
        carouselCssInjected = true;
        var href = window.psCarouselCssUrl;
        if (!href || document.querySelector('link[href="' + href + '"]')) return;
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
    }

    // For now, show every tile side by side in one horizontal row rather than paging through
    // Bootstrap's multi-item-per-slide carousel — with only a handful of mock/live tiles there's
    // nothing to page through yet, and this sidesteps relying on commerceLayouts/carousel.css's
    // .carousel-md-4 transform math loading/caching correctly. Overrides Bootstrap's core
    // ".carousel-item:not(.active){display:none}" so all items stay visible; once a zone
    // regularly carries ~10+ tiles, swap this for real multi-slide paging (the .active/wrapping
    // structure and finalizeCarousel()'s indicator/insufficient-slides bookkeeping below already
    // support it) instead of an ever-growing single row.
    var layoutCssInjected = false;
    function ensureRowLayoutCssLoaded() {
        if (layoutCssInjected) return;
        layoutCssInjected = true;
        var css = '.ps-zone .carousel-inner{display:flex;flex-wrap:nowrap;overflow-x:auto;}'
            + '.ps-zone .carousel-item{display:block !important;flex:0 0 auto;width:220px;margin-right:1rem;}'
            + '.ps-zone .carousel-control-prev,.ps-zone .carousel-control-next,.ps-zone .pd-carousel-indicators{display:none;}';
        var style = document.createElement('style');
        style.setAttribute('data-ps-row-layout', '');
        style.appendChild(document.createTextNode(css));
        document.head.appendChild(style);
    }

    // Wraps a hydrated tile in the Bootstrap-carousel slide markup carousel.js/bootstrap's
    // Carousel plugin expect — exactly one .carousel-item needs .active or Bootstrap has
    // nothing to show.
    function wrapCarouselItem(tile, isFirst) {
        var item = document.createElement('div');
        item.className = 'carousel-item' + (isFirst ? ' active' : '');
        item.appendChild(tile);
        return item;
    }

    // Tells the carousel shell (rendered empty server-side, see productRecommendations.isml)
    // how many slides it now holds: sets data-number-of-slides for carousel.js's own
    // touch-swipe/hidden-slides logic, toggles the insufficient-<bp>-slides classes that hide
    // prev/next controls when there's nothing to page through at that breakpoint, and rebuilds
    // the indicator dots. Mirrors einsteinCarousel.js's showControls()/fillDomElement().
    function finalizeCarousel(zoneEl, tileCount) {
        var carousel = zoneEl.querySelector('[data-ps-carousel]');
        if (!carousel) return;

        carousel.setAttribute('data-number-of-slides', tileCount);

        var slidesPerBreakpoint = { xs: 1, sm: 2, md: 4 };
        Object.keys(slidesPerBreakpoint).forEach(function (bp) {
            carousel.classList.toggle('insufficient-' + bp + '-slides', tileCount <= slidesPerBreakpoint[bp]);
        });

        var indicators = zoneEl.querySelector('[data-ps-indicators]');
        if (indicators) {
            while (indicators.firstChild) {
                indicators.removeChild(indicators.firstChild);
            }
            for (var i = 0; i < tileCount; i += 1) {
                var indicator = document.createElement('li');
                indicator.setAttribute('data-position', String(i));
                if (i === 0) indicator.classList.add('active');
                indicators.appendChild(indicator);
            }
        }

        // Bootstrap's own carousel data-api (bound globally via app_storefront_base's
        // thirdParty/bootstrap.js) handles prev/next clicks without any init call here — this
        // is only for carousel.js's accessibility pass, which recomputes on this custom event.
        if (window.jQuery) {
            window.jQuery('body').trigger('carousel:setup');
        }
    }

    // items is this zone's pre-fetched slice of the page-level decision call (see
    // getPersonalizationDecisions / fetchConfigAndInit below) — renderZone no longer calls
    // Personalization.fetch() itself. personalizationId is the single value shared by every
    // item in this point's decision response (see getPersonalizationDecisions above).
    function renderZone(zoneEl, config, items, personalizationId) {
        var pointName = zoneEl.getAttribute('data-ps-point') || config.pointName;
        // Set server-side by productRecommendations.isml from the slot template's renderMode
        // (see slots/personalization/{home,cart}.isml vs. their -sfra variants) — chooses
        // between client-side SCAPI hydration and the native Tile-Show fragment fetch below.
        var renderMode = zoneEl.getAttribute('data-ps-render-mode') || 'scapi';
        var maxTiles = parseInt(zoneEl.getAttribute('data-ps-max-tiles'), 10) || config.maxTiles || 8;
        var row = zoneEl.querySelector('[data-ps-tile-row]');
        // Scoped to zoneEl (not a document-wide id lookup) so multiple component
        // instances can each carry their own tile template on the same page. Only the
        // scapi/mock paths clone this template — sfra mode renders native server fragments
        // and never touches it, so it isn't required in that mode.
        var template = zoneEl.querySelector('[data-ps-tile-template]');
        if (!row || (renderMode !== 'sfra' && !template)) return;

        // Read back by the zone's single delegated click listener (bindClickTracking) — set
        // once per render pass since every tile in this zone shares the same personalizationId.
        zoneEl.setAttribute('data-ps-personalization-id', personalizationId || '');
        bindClickTracking(zoneEl, row, config);

        row.setAttribute('aria-busy', 'true');

        // Whether the optional SCAPI live-hydration step can run. When these preferences are
        // unset (the current POC goal is only to surface product IDs from the Personalization
        // engine), we deliberately skip the token + product-lookup calls so a missing SCAPI
        // config can never break — or mask — the personalization decision itself.
        var scapiConfigured = !!(config.shortCode && config.organizationId && config.clientId && config.siteId);

        // Carries personalizationContentId alongside each product id (see
        // getPersonalizationDecisions above) so trackRenderedTile can fire an accurately
        // per-item "personalization-view" once each tile actually renders below.
        var entries = (items || []).map(function (item) {
            return {
                productId: item[config.productIdField || 'ssot__Id__c'],
                personalizationContentId: item.personalizationContentId
            };
        }).filter(function (entry) { return !!entry.productId; });
        var cappedEntries = entries.slice(0, maxTiles);
        var capped = cappedEntries.map(function (entry) { return entry.productId; });

        Promise.resolve()
            .then(function () {
                if (renderMode === 'sfra') {
                    return renderSfraZone(zoneEl, config, cappedEntries, row, personalizationId);
                }

                // Only hydrate live tiles when SCAPI is configured.
                if (!scapiConfigured) {
                    console.log('[PersonalizationTiles] SCAPI not configured — rendering ' + capped.length
                        + ' dummy tile(s) for personalization point "' + pointName + '" from the product ID(s) returned by the Personalization engine.');
                    // No SCAPI hydration path yet: render placeholder tiles from the product ids
                    // so the decision -> point -> slot wiring is visible end to end. Swap this
                    // for live hydration once SCAPI/SLAS access is set up.
                    row.innerHTML = '';
                    cappedEntries.forEach(function (entry, index) {
                        var tile = hydrateMockTile(template, entry.productId);
                        trackRenderedTile(tile, config, personalizationId, entry);
                        row.appendChild(wrapCarouselItem(tile, index === 0));
                    });
                    zoneEl.hidden = capped.length === 0;
                    finalizeCarousel(zoneEl, capped.length);
                    return;
                }

                // Run alongside (not after) the SCAPI product lookup — both are keyed off the
                // same capped id list and neither depends on the other's result.
                var productsPromise = getShopperToken(config)
                    .then(function (token) {
                        return fetchLiveProductData(capped, config, token);
                    });
                var serverPricesPromise = fetchServerPrices(capped, config);

                return Promise.all([productsPromise, serverPricesPromise])
                    .then(function (results) {
                        var products = results[0];
                        var serverPrices = results[1];
                        row.innerHTML = '';
                        var tileCount = 0;
                        products.forEach(function (product) {
                            var tile = hydrateTile(template, product, config);
                            if (tile) {
                                applyServerPrice(tile, serverPrices[product.id]);
                                var entry = cappedEntries.filter(function (candidate) {
                                    return candidate.productId === product.id;
                                })[0];
                                trackRenderedTile(tile, config, personalizationId, entry);
                                row.appendChild(wrapCarouselItem(tile, tileCount === 0));
                                tileCount += 1;
                            }
                        });
                        // Nothing to show (empty decision, all SKUs filtered) — hide the zone
                        // rather than leave a bare heading with no tiles beneath it.
                        zoneEl.hidden = tileCount === 0;
                        finalizeCarousel(zoneEl, tileCount);
                    });
            })
            .catch(function (error) {
                zoneEl.hidden = true;
                console.error('[PersonalizationTiles] Failed to render personalization point "' + pointName + '":', error);
            })
            .then(function () {
                row.setAttribute('aria-busy', 'false');
            });
    }

    // Resolves the decision for a batch of zones (each zone's point name deduped within the
    // batch, same as before) and renders each one. Split out of fetchConfigAndInit so it can be
    // called once per "batch of zones that just became visible" instead of once for every zone
    // on the page up front — see observeZonesForLazyRender below.
    function renderZoneBatch(zones, config) {
        var pointNamesByZone = zones.map(function (zoneEl) {
            return zoneEl.getAttribute('data-ps-point') || config.pointName;
        });
        var uniquePointNames = pointNamesByZone.filter(function (pointName, index) {
            return pointNamesByZone.indexOf(pointName) === index;
        });

        getPersonalizationDecisions(uniquePointNames, config.productIdField || 'ssot__Id__c')
            .then(function (decisionsByPoint) {
                zones.forEach(function (zoneEl, index) {
                    var decision = decisionsByPoint[pointNamesByZone[index]] || {};
                    renderZone(zoneEl, config, decision.items, decision.personalizationId);
                });
            });
    }

    // Defers each zone's decision + hydration cost until it's about to be scrolled into view,
    // instead of paying for every personalization point on the page (including e.g. a
    // below-the-fold cart cross-sell zone a shopper may never scroll to) on every page load.
    // rootMargin gives a little lead time so tiles are ready by the time the zone is actually
    // visible. Zones that become visible together (most commonly: everything above the fold on
    // initial load) are still batched into one getPersonalizationDecisions() call, same as
    // before — only genuinely below-the-fold zones lose that batching, trading a few extra
    // decision calls later for not fetching them at all until needed.
    function observeZonesForLazyRender(zones, config) {
        if (typeof IntersectionObserver === 'undefined') {
            // No IntersectionObserver support in this browser — fall back to rendering
            // everything immediately rather than never rendering personalization at all.
            renderZoneBatch(zones, config);
            return;
        }

        var observer = new IntersectionObserver(function (entries) {
            var readyZones = entries
                .filter(function (entry) { return entry.isIntersecting; })
                .map(function (entry) { return entry.target; });

            readyZones.forEach(function (zoneEl) { observer.unobserve(zoneEl); });
            if (readyZones.length) renderZoneBatch(readyZones, config);
        }, { rootMargin: '200px 0px' });

        zones.forEach(function (zoneEl) { observer.observe(zoneEl); });
    }

    // Both the plain include and the Page Designer render template call this on
    // DOMContentLoaded; guard here (not per-template) so any number of instances on
    // one page still only fetch config/tokens and set up lazy rendering a single time.
    var initStarted = false;

    function fetchConfigAndInit(configUrl, dcSdkUrl) {
        if (initStarted) return;
        initStarted = true;

        ensureCarouselCssLoaded();
        ensureRowLayoutCssLoaded();

        // Started in parallel with (not chained after) the GetConfig fetch below: dcSdkUrl is a
        // static site preference the calling template already knows at render time (see
        // productRecommendations.isml), so there's no reason to serialize this behind a second
        // network round-trip just to re-learn a value that never depended on GetConfig's response.
        var sdkPromise = ensureDcSdkLoaded(dcSdkUrl);

        var configPromise = fetchWithTimeout(configUrl, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            });

        Promise.all([configPromise, sdkPromise])
            .then(function (results) {
                var config = results[0];
                if (!config.enabled) return;
                var zones = Array.prototype.slice.call(document.querySelectorAll('[data-ps-point]'));
                observeZonesForLazyRender(zones, config);
            })
            .catch(function (error) {
                console.error('[PersonalizationTiles] Failed to fetch config:', error);
            });
    }

    window.psInitTiles = fetchConfigAndInit;
})();
