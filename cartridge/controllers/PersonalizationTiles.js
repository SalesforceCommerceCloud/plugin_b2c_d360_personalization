'use strict';

var server = require('server');

/**
 * Returns the client-side config for the personalization → SCAPI tile-hydration flow.
 * Called asynchronously from the storefront after page load.
 * Not cached: the documented B2C Commerce dynamic-caching vary-by dimensions are promotions,
 * sorting rules, price books, and ABTest groups (via response.setVaryBy) — currency is not
 * among them, and this response embeds req.session.currency. A 24h cache previously applied
 * here would bake the first shopper's session currency into every response served from that
 * cache entry for a full day (wrong prices/formatting for everyone else on a multi-currency
 * site), so this endpoint is intentionally left uncached.
 */
server.get('GetConfig', server.middleware.https, function (req, res, next) {
    var URLUtils = require('dw/web/URLUtils');
    var Site = require('dw/system/Site');
    var Locale = require('dw/util/Locale');
    var Logger = require('dw/system/Logger');
    var configHelper = require('*/cartridge/scripts/personalization/configHelper');

    try {
        var currentSite = Site.getCurrent();
        var config = configHelper.getConfig();
        var enabled = config.enabled;

        if (!enabled) {
            res.json({ enabled: false });
            return next();
        }

        var locale = Locale.getLocale(req.locale.id);
        var localeCode = (locale.getLanguage() || 'en') + '-' + (locale.getCountry() || 'US');

        // eslint-disable-next-line no-nested-ternary
        var currency = (req.session && req.session.currency && req.session.currency.currencyCode)
            ? req.session.currency.currencyCode
            : (currentSite.getDefaultCurrency() ? currentSite.getDefaultCurrency().getCurrencyCode() : 'USD');

        // Placeholder token the client swaps for the real product id — gives the client a
        // locale-correct, SEO-friendly product URL without a per-tile server round trip.
        var productUrlTemplate = URLUtils.url('Product-Show', 'pid', 'PS_PID_PLACEHOLDER').toString();

        // Same placeholder-swap pattern as productUrlTemplate above, but for the "sfra"
        // render-mode zones (see productRecommendations.isml / renderZone in
        // personalizationTiles.js): the native, already-cached Tile-Show fragment for a
        // product id, fetched same-origin instead of hydrating via SCAPI. Built here (not
        // client-side) so the client never needs to know the route's param shape.
        var tileUrlTemplate = URLUtils.url('Tile-Show', 'pid', 'PS_PID_PLACEHOLDER', 'swatches', true, 'ratings', true).toString();

        // Same-origin endpoint the client calls for a guest SLAS token — see
        // scripts/personalization/slasGuestToken.js for why the PKCE exchange happens here
        // instead of in browser JS.
        var getTokenUrl = URLUtils.url('PersonalizationTiles-GetToken').toString();

        // Same-origin endpoint the client calls (batched, ?ids=a,b,c) to get storefront-parity
        // list/sale price HTML for "scapi" render-mode tiles — see GetPrices below for why this
        // can't come from the SCAPI product response itself.
        var pricesUrl = URLUtils.url('PersonalizationTiles-GetPrices').toString();

        res.json({
            shortCode: config.shortCode,
            organizationId: config.organizationId,
            clientId: config.clientId,
            siteId: config.siteId,
            getTokenUrl: getTokenUrl,
            pricesUrl: pricesUrl,
            pointName: config.pointName,
            expand: config.expand,
            maxTiles: config.maxTiles,
            locale: localeCode,
            currency: currency,
            productUrlTemplate: productUrlTemplate,
            tileUrlTemplate: tileUrlTemplate,
            dcSdkUrl: config.dcSdkUrl,
            productIdField: config.productIdField,
            activityTrackingEnabled: config.activityTrackingEnabled,
            enabled: true
        });
    } catch (error) {
        Logger.error('PersonalizationTiles-GetConfig failed: {0}', error.message);
        res.setStatusCode(500);
        res.json({ error: 'Failed to load personalization tile config' });
    }

    return next();
});

/**
 * Mints a fresh guest SLAS access token server-side (see scripts/personalization/
 * slasGuestToken.js for why this can't be done in browser JS) and hands it to the client,
 * which caches it in sessionStorage until it expires. Not cached at the response level —
 * each call must mint its own token/authorization-code pair.
 */
server.get('GetToken', server.middleware.https, function (req, res, next) {
    var Logger = require('dw/system/Logger');
    var configHelper = require('*/cartridge/scripts/personalization/configHelper');
    var slasGuestToken = require('*/cartridge/scripts/personalization/slasGuestToken');

    try {
        var config = configHelper.getConfig();
        var token = slasGuestToken.getGuestToken(config);
        res.json({
            accessToken: token.accessToken,
            expiresIn: token.expiresIn
        });
    } catch (error) {
        Logger.error('PersonalizationTiles-GetToken failed: {0}', error.message);
        res.setStatusCode(500);
        res.json({ error: 'Failed to obtain guest token' });
    }

    return next();
});

/**
 * Returns storefront-parity price HTML (list/sale strike-through markup, same template as
 * native product tiles) for a batch of product ids. SCAPI Shopper Products only ever returns
 * one resolved price per product — it can't tell a shopper-facing "list" price apart from a
 * price-book markdown, which is why "scapi" render-mode tiles couldn't show the strike-through
 * that "sfra" render-mode tiles get for free from Tile-Show.
 *
 * Reuses the exact building blocks Tile-Show's own product-tile model uses (models/product/
 * productTile.js) — a ProductSearchModel hit + decorators/searchPrice + promotionCache — rather
 * than dw.catalog.Product.getPriceModel() directly: on this catalog, price/promotion resolution
 * for tile-type contexts only comes back available through the search index, not a raw
 * ProductMgr.getProduct() price model, so mirroring the search-hit path is what keeps this in
 * parity with (not just similar to) native tiles.
 */
/**
 * Same session-currency resolution GetConfig uses above, extracted so GetPrices' cache key
 * matches what the shopper actually sees.
 * @param {Object} req - SFRA request object
 * @returns {string} ISO currency code
 */
function resolveSessionCurrency(req) {
    if (req.session && req.session.currency && req.session.currency.currencyCode) {
        return req.session.currency.currencyCode;
    }
    var Site = require('dw/system/Site');
    var defaultCurrency = Site.getCurrent().getDefaultCurrency();
    return defaultCurrency ? defaultCurrency.getCurrencyCode() : 'USD';
}

/**
 * Computes storefront-parity price HTML for one product id, the same building blocks
 * GetPrices used inline before this was extracted for caching (see getCachedPriceEntry below).
 * @param {string} id - product id
 * @returns {Object|null} { rendered: <price HTML> }, or null if the id doesn't resolve
 */
function computePriceEntry(id) {
    var ProductMgr = require('dw/catalog/ProductMgr');
    var productHelper = require('*/cartridge/scripts/helpers/productHelpers');
    var promotionCache = require('*/cartridge/scripts/util/promotionCache');
    var searchPriceDecorator = require('*/cartridge/models/product/decorators/searchPrice');
    var priceHelper = require('*/cartridge/scripts/helpers/pricing');

    var product = ProductMgr.getProduct(id);
    if (!product) return null;

    var searchHit = productHelper.getProductSearchHit(product);
    if (!searchHit) return null;

    var priceObj = {};
    searchPriceDecorator(priceObj, searchHit, promotionCache.promotions, productHelper.getProductSearchHit);

    // No explicit templatePath: renderHtml()'s default is ajaxMain.isml, which is the
    // correct entry point for a raw Template.render(HashMap) call — it bridges the
    // context map's param.price into the page-scope "price" variable that main.isml
    // (and everything it includes) expects. main.isml itself assumes that page-scope
    // variable already exists (normally set by whatever page included it), so calling
    // it directly here produced an undefined price and rendered "null" for every field.
    return {
        rendered: priceHelper.renderHtml(priceHelper.getHtmlContext({ price: priceObj.price }))
    };
}

/**
 * Same computed price HTML as computePriceEntry, cached per (productId, currency). Added
 * because GetPrices previously recomputed this — a ProductMgr lookup plus a full ISML
 * Template.render() — for every id on every request, with no caching at all (only the HTTP
 * response itself was left uncached, due to currency varying by session — see the class-level
 * docblock above). Currency is part of the cache key, so that constraint still holds; this only
 * removes the *redundant* recomputation across shoppers/requests hitting the same product+
 * currency inside the TTL window. See Performance report §2.3.
 *
 * The cache itself — id "personalizationTilesPrices" and its TTL — is registered in this
 * cartridge's caches.json (referenced from package.json), not here: dw.system.Cache.put() has
 * no per-call TTL parameter, only put(key, value); TTL is fixed at registration time via
 * caches.json's expireAfterSeconds.
 * @param {string} id - product id
 * @param {string} currency - currency code, part of the cache key
 * @returns {Object|null} { rendered: <price HTML> }, or null if the id doesn't resolve
 */
function getCachedPriceEntry(id, currency) {
    var CacheMgr = require('dw/system/CacheMgr');
    var cache = CacheMgr.getCache('personalizationTilesPrices');
    var cacheKey = id + '|' + currency;

    var cached = cache.get(cacheKey);
    if (cached) return cached;

    var priceEntry = computePriceEntry(id);
    if (priceEntry) {
        cache.put(cacheKey, priceEntry);
    }
    return priceEntry;
}

server.get('GetPrices', server.middleware.https, function (req, res, next) {
    var Logger = require('dw/system/Logger');

    var ids = (req.querystring.ids || '').split(',')
        .map(function (id) { return id.trim(); })
        .filter(Boolean);
    var currency = resolveSessionCurrency(req);
    var prices = {};

    ids.forEach(function (id) {
        try {
            var priceEntry = getCachedPriceEntry(id, currency);
            if (priceEntry) {
                prices[id] = priceEntry;
            }
        } catch (error) {
            Logger.error('PersonalizationTiles-GetPrices failed for product {0}: {1}', id, error.message);
        }
    });

    res.json({ prices: prices });
    return next();
});

module.exports = server.exports();
