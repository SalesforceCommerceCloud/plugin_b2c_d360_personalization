# plugin_b2c_d360_personalization

**Version:** 1.0.0

SFRA cartridge that decouples storefront product recommendations from Data Cloud ingestion latency: a personalization engine returns product IDs only (resolved from shopper context), and this cartridge hydrates them with **live** price/promotion/availability/image data from B2C Commerce's SCAPI Shopper Products API, then renders into the storefront's existing product-tile component.

```
Shopper Browser → Personalization Engine (decision JSON: product IDs only)
                → this cartridge (client-side JS)
                → SCAPI Shopper Products (?ids=...&expand=prices,promotions,availability,images)
                → hydrate existing cached product-tile → render
```

Data Cloud never sits on this path — every price/promo/availability field comes live from B2C Commerce at request time.

## Status

Rough / not production-ready — in particular, the tile markup selectors are placeholders, and the `scapi` render mode needs a SLAS public (PKCE) client plus a separate SCAPI CORS Preferences registration for the storefront domain before it can hydrate live — resolved on sandbox `zzbf-001`/site `RefArch` as of 2026-09-21, but this registration is per-realm/per-`client_id`+site and must be repeated for any other environment.

## Setup

This cartridge has no build step of its own — it drops into the target storefront project as-is. In short:

1. **Cartridge path.** Add `plugin_b2c_d360_personalization` to the site's Cartridge Path (Business Manager → Administration → Sites → Manage Sites → *Site* → Settings), before the storefront's base cartridge (e.g. `app_storefront_base`).
2. **Deploy the code** using the target storefront project's own build/upload tooling (WebDAV, `sfcc-ci`, the SFCC VS Code extension, etc.) — or, if you have the B2C Commerce CLI configured, `b2c code deploy --code-version <version> --cartridge plugin_b2c_d360_personalization --reload` (see [Deploy and Iterate with the B2C Commerce CLI](https://developer.salesforce.com/docs/commerce/b2c-commerce/guide/b2c-cartridges.html)).
3. **Import the metadata** — upload and import [`cartridge/meta/ps-personalization-meta-import.zip`](cartridge/meta/ps-personalization-meta-import.zip) via Business Manager → Administration → Site Development → Import & Export.
4. **Set Site Preferences** — see [Configuration](#configuration) below. At minimum set `ps_enabled` to see the dummy-tile preview end to end; the `ps_scapi*` preferences are only needed once live SCAPI hydration is wired up.
5. **Place a recommendation zone** — Content Slot, Page Designer, or a static template include — see [Usage](#usage) below. Pick a [render mode](#render-mode-scapi-hydration-vs-native-sfra-tile) while you're there.

## Structure

| Path | Purpose |
|------|---------|
| `cartridge/controllers/PersonalizationTiles.js` | `PersonalizationTiles-GetConfig` — serves client config (uncached; varies by currency/locale) |
| `cartridge/scripts/personalization/configHelper.js` | Reads `ps_*` Site Preferences |
| `cartridge/scripts/personalization/slasGuestToken.js` | Server-side SLAS guest PKCE token exchange, used by the `scapi` render mode |
| `cartridge/static/default/js/personalizationTiles.js` | Client-side flow: decision → SLAS token → SCAPI fetch → hydrate → render |
| `cartridge/templates/default/personalization/productRecommendations.isml` | Drop-in include with the reusable tile `<template>` |
| `cartridge/experience/components/personalization/productRecommendations.json` | Page Designer custom component type — BM-editable `title`/`personalizationPointName`/`maxTiles`/`contextKey` attributes |
| `cartridge/experience/components/personalization/productRecommendations.js` | Page Designer render script — reads per-instance attributes, falls back to `ps_*` preferences |
| `cartridge/templates/default/experience/components/personalization/productRecommendations.isml` | Page Designer render template (same tile `<template>` markup, kept in sync with the plain include) |
| `cartridge/templates/default/slots/personalization/home.isml`, `cart.isml` | Example Content Slot rendering templates, **SCAPI mode** — each hardcodes its own `contextKey`, then delegates to the plain include |
| `cartridge/templates/default/slots/personalization/home-sfra.isml`, `cart-sfra.isml` | Same example slots, **SFRA native-tile mode** (`renderMode = 'sfra'`) — assign one of these instead to switch modes |
| `cartridge/templates/default/slots/personalization/pdp.isml`, `pdp-sfra.isml` | Same pattern for a PDP recommendation zone (**SCAPI** / **SFRA native-tile** modes) |
| `cartridge/templates/default/slots/personalization/home-scapi-compare.isml` | Example slot rendering both render modes side by side, for comparison during setup |
| `cartridge/meta/system-objecttype-extensions.xml` | Business Manager Site Preference definitions for all `ps_*` config (source of truth for `ps-personalization-meta-import.zip`) |

## Configuration

Set these in Business Manager → Merchant Tools → Site Preferences → Custom Preferences → **Data Cloud Personalization**:

| Preference | Required | Description |
|------------|----------|--------------|
| `ps_enabled` | | Enable/disable the feature |
| `ps_scapiShortCode` | Yes | SCAPI short code (e.g. `kv7kzm78`) |
| `ps_scapiOrgId` | Yes | Commerce API organization id (e.g. `f_ecom_zzrf_001`) |
| `ps_scapiClientId` | Yes | Public (PKCE) SLAS client id for guest/shopper tokens |
| `ps_scapiSiteId` | Yes | SCAPI site id (e.g. `RefArchGlobal`) |
| `ps_scapiRedirectUri` | Yes | A `redirect_uri` registered on the `ps_scapiClientId` SLAS client in Account Manager/SLAS Admin. Used server-side only for the guest PKCE token exchange (`PersonalizationTiles-GetToken`) — SLAS never actually delivers a response there, so it does not need to be reachable, only registered. |
| `ps_personalizationPointName` | | Default personalization point/decision name to request when a slot has no explicit point name and no matching entry in `ps_pointNameMap` |
| `ps_pointNameMap` | | Optional JSON map resolving a slot's context key to a personalization point name, nested by delivery architecture (`sfra`/`pageDesigner`/`pwa`/`common`). See `resolvePointName()` in `configHelper.js` for the resolution order. Whatever point name(s) end up referenced here must already be provisioned as Decision Points on the Data Cloud/Salesforce Personalization side — this cartridge only maps a storefront context key to one, it does not create it. |
| `ps_maxTiles` | | Max tiles per zone (default 8; SCAPI caps batches at 24 ids) |
| `ps_expand` | | SCAPI `expand` params (default `availability,images,prices,promotions,variations`) |
| `ps_productIdField` | | Field name on each Personalization decision item that holds the product id. Default: `ssot__Id__c` — varies by customer implementation. |
| `ps_activityTrackingEnabled` | | Enable/disable sending `personalization-view`/`personalization-click` activity events for rendered tiles. Default `true`. Requires `ps_dcSdkUrl` to be set — tracking fails silently without a working URL there. |
| `ps_dcSdkUrl` | | Tenant-specific Data Cloud/Salesforce Interactions beacon SDK script URL (exposes `window.getSalesforceInteractions()`), e.g. `https://cdn.c360a.salesforce.com/beacon/c360a/<org-guid>/scripts/c360a.min.js`. Provisioned per tenant by the Data Cloud team, not invented locally. |

## Usage

Three ways to place a recommendation zone:

- **Content Slot:** wire an `<isslot>` placeholder into the target storefront's own page templates (e.g. homepage, cart) — this is a code change to that storefront's templates, not something this cartridge ships pre-wired, since slot ids and page layout are storefront-specific. The example templates under `cartridge/templates/default/slots/personalization/` show the pattern (hardcode a `contextKey`, delegate to the plain include) — copy and adapt one per placement. Then configure the slot in Business Manager:
  1. **Merchant Tools → Online Marketing → Content Slots.**
  2. Open (or create) the slot configuration for that slot id.
  3. **Content Type:** any value is fine (e.g. leave the default `Product`) — this rendering template never reads `slotcontent.getContent()`/`getRecommenderName()`, so Content Type has no effect on what renders. Do **not** pick `Recommendation` — that's B2C Commerce's native Einstein/Merchandising recommender picker, unrelated to this cartridge's Personalization/Data Cloud flow.
  4. **Template:** point at your adapted `scapi`-mode template for that placement (default), or its `-sfra` counterpart to use **SFRA native-tile mode** instead — see [Render mode](#render-mode-scapi-hydration-vs-native-sfra-tile) below.
  5. Set a schedule/customer-group rule if desired, then **Assign** and activate the configuration.

  There is no generic "Custom Attributes" field on the Slot Configuration screen, so `contextKey` isn't read from the slot instance — each slot points at its own small dedicated template which hardcodes its `contextKey`, then delegates to the shared `productRecommendations.isml` include. Adding a new slot elsewhere means adding one more small template (hardcoding that page's `contextKey`) and pointing a new slot's Template field at it — still no changes to `productRecommendations.isml` itself, and `ps_pointNameMap` still resolves the actual personalization point name per `contextKey`.
- **Page Designer:** drag the **"Personalization Product Recommendations"** component (group: Personalization) onto a page/region in Business Manager Page Designer, and set its `Title` / `Personalization Point Name` / `Max Tiles` / `Context Key` / `Render Mode` attributes per instance. Multiple instances on one page are supported — each can reference a different personalization point (e.g. a homepage carousel vs. a PDP carousel), and all instances on a page are covered by a single Personalization decision call.

  **If the component doesn't appear in the Add Component picker at all**, even with the cartridge active on the site's cartridge path/code version: Page Designer silently drops a component descriptor from its registry if `<group>/<id>.json` fails schema validation, with no error in the picker itself — check **Administration → Operations → Log Files** for `ComponentType schema validation of '<id>.json' failed`. Common schema gotchas: there's no numeric attribute type (use `string`), and `region_definitions` is effectively required.
- **Static page templates:** include `productRecommendations.isml` directly, e.g.:

```isml
<isinclude template="personalization/productRecommendations" />
```

All three paths converge on the same `productRecommendations.isml` include, so there is one tile markup/decision-call implementation to maintain. Swap the placeholder tile markup/selectors inside the `<template>` block for this storefront's actual product-tile markup — **in both** `templates/default/personalization/productRecommendations.isml` **and** `templates/default/experience/components/personalization/productRecommendations.isml`, since Page Designer render templates can't share an `<isinclude>` with a plain controller template — and wire `getPersonalizationDecisions()` in `personalizationTiles.js` to the real Salesforce Interactions SDK call for this tenant.

### Horizontal carousel

Tiles render inside `app_storefront_base`'s existing Bootstrap-carousel shell markup (`.carousel`/`.carousel-inner`/`.carousel-item`, controls, indicator `<ol>`) rather than a second carousel implementation — the shell is rendered empty server-side, and `personalizationTiles.js` fills `.carousel-inner` with `.carousel-item`-wrapped tiles once the decision/hydration resolves (mirroring `einsteinCarousel.js`'s async-fill pattern). `finalizeCarousel()` still tracks slide count and rebuilds indicators, ready for real multi-slide paging later.

For now, `ensureRowLayoutCssLoaded()` injects a small CSS override (a plain `<style>` tag, not a stylesheet URL) that shows every tile side by side in one horizontal, scrollable row and hides the prev/next controls and indicator dots — with only a handful of tiles per zone there's nothing worth paging through yet, and this sidesteps depending on `commerceLayouts/carousel.css`'s multi-item transform math loading correctly. Swap this for real `carousel-sm-2`/`carousel-md-4`-style multi-slide paging once a zone regularly carries far more tiles (e.g. ~10+ products) than fit on screen.

`carousel.js`/`carousel.css` are **not** loaded via `assets.addCss`/`assets.addJs` — this template can render deep inside a page body (a Content Slot, or a Page Designer component placed anywhere on the page), well after `common/layout/htmlHead` has already printed the page's `<head>`, so anything registered that late never reaches the page. `carousel.js` loads via a plain inline `<script src>` tag (same pattern as `personalizationTiles.js`); `carousel.css` is injected into `<head>` client-side by `personalizationTiles.js` (`ensureCarouselCssLoaded()`, reading `window.psCarouselCssUrl`) the first time any zone initializes on the page.

### Dummy tiles until SCAPI/SLAS is configured

Until `ps_scapiShortCode` / `ps_scapiOrgId` / `ps_scapiClientId` / `ps_scapiSiteId` are all set, `renderZone()` in `personalizationTiles.js` does **not** call SCAPI — it renders a placeholder tile per product id returned by the Personalization decision (label "Mock product `<id>`", no image/price, a "Preview — SCAPI not yet connected" badge), so the decision → point → slot wiring is visible end to end before real product hydration is wired up. Once the SLAS client / SCAPI prefs are in place, the exact same slots switch to live product tiles automatically — no template or slot reconfiguration needed.

### Render mode: SCAPI hydration vs. native SFRA tile

Every zone renders in one of two modes, read from a `data-ps-render-mode` attribute on the `.ps-zone` element:

| Mode | How tiles are built | When to use it |
|---|---|---|
| `scapi` | Client-side: SLAS guest token → SCAPI Shopper Products `?ids=...` → hydrate the placeholder `<template>` | Needs a SLAS public (PKCE) client, a separate SCAPI CORS Preferences registration for the storefront domain (not a setting on the SLAS client itself), and the five `ps_scapi*` preferences. Guest pricing only — see [Status](#status). |
| `sfra` (default, customer-ready) | Client-side, per product id: `fetch()` the storefront's own already-cached `Tile-Show?pid=...` controller, same-origin with cookies (`credentials: 'same-origin'`) | No SLAS/Account Manager setup needed. Reflects logged-in/customer-group pricing and promotions for free, since it's the real storefront tile. |

**The mode is chosen entirely in Business Manager, not in code or a Site Preference** — it's just which template a Content Slot (or Page Designer instance) points at:

- **Content Slot:** the *Template* field — a `-sfra` template for `sfra` mode, its non-suffixed counterpart for `scapi` mode. Switching modes is reassigning that one field; no code deploy needed once both templates are on the active code version.
- **Page Designer:** the component's `Render Mode` attribute (`scapi`/`sfra`), set per instance.

`PersonalizationTiles-GetConfig` always returns a `tileUrlTemplate` (the `Tile-Show` route, with a `PS_PID_PLACEHOLDER` token the client swaps for each real product id) alongside the existing `productUrlTemplate` — harmless and unused in `scapi` mode, required in `sfra` mode.

### Troubleshooting

**If a slot renders nothing at all** (view-source shows the bare `<!-- dwMarker="slot" ... -->` comment with nothing after it): that's a slot resolving to no active configuration, or a Content Slot pointed at a template name that doesn't exist on the instance's *active* code version — it is **not** the `ps_enabled` preference (that gate would still leave the empty carousel shell markup out, but so would this, so check both). Fastest way to tell them apart: hit `PersonalizationTiles-GetConfig` directly.
- `enabled: false` → flip the `ps_enabled` Site Preference back on.
- `enabled: true` but the page still shows nothing → check Business Manager → Merchant Tools → Online Marketing → Content Slots for that slot id: is a configuration actually **Assigned/active** (not a Draft), is the **Template** field spelled exactly right, and is there a schedule/customer-group rule excluding you right now?
- If you just switched a slot to `-sfra` and the response is missing `tileUrlTemplate` entirely, the target instance is running an older code version — redeploy and confirm the new version is active in Business Manager → Administration → Site Development → Code.
- `GetConfig` returns `enabled: true` and looks correct, but there are zero `[PersonalizationTiles]` console logs and zero `Tile-Show`/SCAPI network calls, with no error anywhere: the decision call itself likely came back empty (`{"personalizations":[]}`) — confirm with `window.getSalesforceInteractions().Personalization.fetch([pointName]).then(r => console.log(JSON.stringify(r)))` in the console. An empty result here means the point/experience isn't eligible/targeted for the current page in Data Cloud Personalization — a point name that returns real ids on one page (e.g. the homepage) can return nothing on another page even with identical cartridge config. This is a Personalization/Data Cloud admin targeting issue, not a cartridge bug (confirmed on sandbox `zzbf-001`, 2026-09-21).

## Change History

### v1.0.0 — 2026-09-17

Initial release. Cumulative feature set:

- Core cartridge: `PersonalizationTiles-GetConfig` controller, `configHelper.js`, client-side decision → hydrate → render flow (2026-09-02)
- Business Manager Site Preference metadata (`ps_*` custom attributes) (2026-09-02)
- Page Designer custom component for placing a recommendation zone (2026-09-02)
- Real Salesforce Interactions decision SDK call, `sfra` native-tile render mode, and `ps_pointNameMap` point-name resolution (2026-09-09)
- Personalization view/click activity tracking (2026-09-10)
- Site Preference metadata packaged as a Business Manager-importable zip (`ps-personalization-meta-import.zip`) (2026-09-10)
- Server-side SLAS guest PKCE token exchange and Content Slot templates (home/cart, both render modes) (2026-09-17)
- Renamed cartridge id from `plugin_personalization_scapi` to `plugin_b2c_d360_personalization` (2026-09-17)
- Added a setup guide (PDF) (2026-09-17)
