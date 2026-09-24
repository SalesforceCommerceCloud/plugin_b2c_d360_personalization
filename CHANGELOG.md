# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `GetPrices` returning empty prices for every call: `CacheMgr.getCache('personalizationTilesPrices')` had no matching `caches.json`/`package.json` registration, and the surrounding try/catch silently swallowed the resulting failure, breaking strike-through pricing for all `scapi`-mode tiles. Added `caches.json` (60s `expireAfterSeconds`) + `package.json` at the cartridge root, and fixed `getCachedPriceEntry()`'s `cache.put()` call, which passed a third TTL argument `dw.system.Cache.put()` doesn't support (TTL is set via `caches.json` instead). Ported from `sfra-poc` (2026-09-24)
- Page Designer component schema: `maxTiles` attribute changed from `int` to `string` (Page Designer has no numeric attribute type) and added the required `region_definitions` array — both were causing a silent schema-validation failure that kept the component out of the Add Component picker with no visible error, ported from `sfra-poc` (2026-09-21)
- Retired the same-origin `PersonalizationTiles-GetProducts` SCAPI proxy (and the `getProductsUrl` field it added to `GetConfig`'s response): `fetchLiveProductData()` in `personalizationTiles.js` now calls SCAPI Shopper Products directly, cross-origin, from the browser again. The proxy was a stopgap for a SCAPI CORS Preferences blocker that turned out to be a missing `SALESFORCE_COMMERCE_API:<tenant-id>` OAuth scope on the admin token, not a SLAS-client-level CORS allow-list gap — see `SCAPI-CORS-Preferences-Investigation.md`. Ported from `sfra-poc` (2026-09-21). **Anyone deploying this to a new org/site must independently register SCAPI CORS Preferences there — this fix isn't carried by the code merge alone.**

### Added
- `PWAKit-TileFragment-Contract.md` design doc specifying a server-to-server tile-fragment contract for a future PWA Kit storefront, ported from `sfra-poc` (2026-09-21)
- README/PageDesigner-Integration-Guide/PersonalizationSCAPI-Design docs updated with the page-scoped Personalization targeting gotcha discovered wiring the component onto a standalone Page Designer page on sandbox `zzbf-001` — an empty `personalizations` response can be a Data Cloud admin targeting issue rather than a cartridge bug, ported from `sfra-poc` (2026-09-21)
- README Page Designer usage section links to the schema-validation gotcha (component silently missing from the Add Component picker) that was already documented in `PageDesigner-Integration-Guide.md` but not surfaced in README (2026-09-21)
- `SCAPI-CORS-Preferences-Investigation.md`: full writeup of the SCAPI CORS Preferences blocker's root cause and fix (the `SALESFORCE_COMMERCE_API:<tenant-id>` scope gotcha), ported from `sfra-poc` (2026-09-21)
- `PWAKit-Direct-SCAPI-Design.md`: design doc for a PWA Kit storefront calling SCAPI Shopper Products directly (server-side and/or client-side), now that the CORS blocker is resolved — proposed as a simpler alternative to `PWAKit-TileFragment-Contract.md`'s fragment-passthrough approach, ported from `sfra-poc` (2026-09-21)
- Corrected "SLAS client CORS allow-list" terminology (CORS for SCAPI is governed by a separate CORS Preferences admin API, not a setting on the SLAS client itself) across `PersonalizationSCAPI-Design.md`, `Development_HANDOVER.md`, and `PageDesigner-Integration-Guide.md`, ported from `sfra-poc` (2026-09-21)

### Changed
- `GetPrices` now caches rendered price HTML per `(productId, currency)` for 60s via `dw.system.CacheMgr` (`getCachedPriceEntry()`/`computePriceEntry()`), removing a previously-uncached `ProductMgr` lookup + full ISML render per product id on every request, ported from `sfra-poc` (2026-09-23)
- `personalizationTiles.js` no longer hydrates every `[data-ps-point]` zone on page load: `observeZonesForLazyRender()` gates each zone's decision + hydration behind an `IntersectionObserver` (200px lead margin), batching only zones that become visible together — below-the-fold zones (e.g. cart cross-sell) no longer cost a decision/hydration call until scrolled into view, ported from `sfra-poc` (2026-09-23)
- Added `performance.now()` timing instrumentation around `Personalization.fetch()` in `getPersonalizationDecisions()` for request-waterfall diagnostics, ported from `sfra-poc` (2026-09-23)

### Added
- `B2C_D360_personalization_Plugin_Performance_Evaluation.md`/`.pdf`: performance hardening evaluation covering `GetPrices` caching, lazy zone rendering, and per-tile HTTP fan-out (SFRA `sfra` mode, still open), ported from `sfra-poc` (2026-09-23)

## [1.0.0] - 2026-09-17

Initial release. Cumulative feature set:

### Added
- Core cartridge: `PersonalizationTiles-GetConfig` controller, `configHelper.js`, client-side decision → hydrate → render flow (2026-09-02)
- Business Manager Site Preference metadata (`ps_*` custom attributes) (2026-09-02)
- Page Designer custom component for placing a recommendation zone (2026-09-02)
- Real Salesforce Interactions decision SDK call, `sfra` native-tile render mode, and `ps_pointNameMap` point-name resolution ported from the `sfra-poc` reference integration (2026-09-09)
- Personalization view/click activity tracking (2026-09-10)
- Site Preference metadata packaged as a Business Manager-importable zip (`ps-personalization-meta-import.zip`) (2026-09-10)
- Server-side SLAS guest PKCE token exchange, Content Slot templates (home/cart, both render modes), and refreshed design docs, ported from `sfra-poc` (2026-09-17)
- Setup guide (PDF) (2026-09-17), updated to v1.0 (2026-09-20)
- Reorganized `docs/` into `architecture-and-design/`, `deployment-and-setup/`, and `archive/`; the Setup & Deployment Slack Canvas is now the source of truth for setup/deploy steps, superseding `DeploymentGuide.md` (2026-09-17)

### Changed
- Renamed cartridge id from `plugin_personalization_scapi` to `plugin_b2c_d360_personalization` (2026-09-17)

[1.0.0]: https://git.soma.salesforce.com/rvyapuri/plugin_b2c_d360_personalization/releases/tag/v1.0.0
