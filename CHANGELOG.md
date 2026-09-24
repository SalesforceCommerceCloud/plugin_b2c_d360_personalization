# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `GetPrices` returning empty prices for every call: `CacheMgr.getCache('personalizationTilesPrices')` had no matching `caches.json`/`package.json` registration, and the surrounding try/catch silently swallowed the resulting failure, breaking strike-through pricing for all `scapi`-mode tiles. Added `caches.json` (60s `expireAfterSeconds`) + `package.json` at the cartridge root, and fixed `getCachedPriceEntry()`'s `cache.put()` call, which passed a third TTL argument `dw.system.Cache.put()` doesn't support (TTL is set via `caches.json` instead). (2026-09-24)
- Page Designer component schema: `maxTiles` attribute changed from `int` to `string` (Page Designer has no numeric attribute type) and added the required `region_definitions` array — both were causing a silent schema-validation failure that kept the component out of the Add Component picker with no visible error. (2026-09-21)
- Retired the same-origin `PersonalizationTiles-GetProducts` SCAPI proxy (and the `getProductsUrl` field it added to `GetConfig`'s response): `fetchLiveProductData()` in `personalizationTiles.js` now calls SCAPI Shopper Products directly, cross-origin, from the browser again. The proxy had been a stopgap for a SCAPI CORS Preferences blocker. **Anyone deploying this to a new org/site must independently register SCAPI CORS Preferences there — this fix isn't carried by the code merge alone.** (2026-09-21)

### Changed
- `GetPrices` now caches rendered price HTML per `(productId, currency)` for 60s via `dw.system.CacheMgr` (`getCachedPriceEntry()`/`computePriceEntry()`), removing a previously-uncached `ProductMgr` lookup + full ISML render per product id on every request. (2026-09-23)
- `personalizationTiles.js` no longer hydrates every `[data-ps-point]` zone on page load: `observeZonesForLazyRender()` gates each zone's decision + hydration behind an `IntersectionObserver` (200px lead margin), batching only zones that become visible together — below-the-fold zones (e.g. cart cross-sell) no longer cost a decision/hydration call until scrolled into view. (2026-09-23)
- Added `performance.now()` timing instrumentation around `Personalization.fetch()` in `getPersonalizationDecisions()` for request-waterfall diagnostics. (2026-09-23)

## [1.0.0] - 2026-09-17

Initial release. Cumulative feature set:

### Added
- Core cartridge: `PersonalizationTiles-GetConfig` controller, `configHelper.js`, client-side decision → hydrate → render flow (2026-09-02)
- Business Manager Site Preference metadata (`ps_*` custom attributes) (2026-09-02)
- Page Designer custom component for placing a recommendation zone (2026-09-02)
- Real Salesforce Interactions decision SDK call, `sfra` native-tile render mode, and `ps_pointNameMap` point-name resolution (2026-09-09)
- Personalization view/click activity tracking (2026-09-10)
- Site Preference metadata packaged as a Business Manager-importable zip (`ps-personalization-meta-import.zip`) (2026-09-10)
- Server-side SLAS guest PKCE token exchange and Content Slot templates (home/cart, both render modes) (2026-09-17)
- Setup guide (PDF) (2026-09-17), updated to v1.0 (2026-09-20)

### Changed
- Renamed cartridge id from `plugin_personalization_scapi` to `plugin_b2c_d360_personalization` (2026-09-17)
