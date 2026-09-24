# Page Designer Integration Guide — SCAPI-Hydrated Recommendations

> **Status: Internal — not for customer distribution yet.** This guide covers the `scapi` render mode (client-side SLAS PKCE → SCAPI Shopper Products, browser-to-SCAPI CORS calls). It stays internal-only until the CORS/SLAS PKCE blockers noted in [PersonalizationSCAPI-Design.md](../architecture-and-design/PersonalizationSCAPI-Design.md) are cleared and we go live with client-side CORS-based SCAPI product calls. The `sfra` render mode is unaffected and already customer-ready.

**Related:** [Setup & Deployment Slack Canvas](https://salesforce.enterprise.slack.com/docs/T2E6RHTM0/F0C2HGRUPR9) (full deploy/rollback, source of truth), [PersonalizationSCAPI-Design.md](../architecture-and-design/PersonalizationSCAPI-Design.md) (HLD/TSD), [PWAKit-TileFragment-Contract.md](../architecture-and-design/PWAKit-TileFragment-Contract.md) (server-to-server tile fragment contract for a future PWA Kit storefront), [../../README.md](../../README.md)

This guide walks through standing up a **standalone Page Designer page** on a sandbox that places the **"Personalization Product Recommendations"** component in `scapi` render mode (client-side SLAS PKCE token → SCAPI Shopper Products hydration). It assumes the cartridge is already in the repo — no new code is needed, this is a Business Manager content-authoring exercise plus environment config.

Worked example below uses sandbox `zzbf-001`, site `RefArch`, org `f_ecom_zzbf_001`, SCAPI short code `jcyuoges` — substitute your own instance's values.

---

## 1. Confirm code + cartridge path

1. Cartridge path for the target site (**Administration → Sites → Manage Sites → [Site] → Settings**) must include `plugin_b2c_d360_personalization` **before** `app_storefront_base`. Recommended order: `app_storefront_poc:plugin_b2c_d360_personalization:app_storefront_base`.
2. Deploy/refresh code from the repo root:
   ```
   npm run compile:js
   npm run compile:scss
   npm run compile:fonts
   npm run uploadCartridge
   ```
3. Activate the uploaded code version in **Administration → Site Development → Code**.

Without an active code version containing this cartridge on the cartridge path, the component will not appear in the Page Designer component picker at all — this is the most common "I don't see it" cause.

**If the cartridge/code version is confirmed correct and the component still doesn't appear:** Page Designer silently drops a component descriptor from its registry if `<group>/<id>.json` fails schema validation — no error surfaces in the Add Component picker itself. Check **Administration → Operations → Log Files** for `ComponentType schema validation of '<id>.json' failed`. Two schema gotchas that cause this: there is no numeric attribute type (use `"type": "string"` and parse the value client-side/server-side, never `"type": "int"`), and `region_definitions` is effectively required — every valid component in `app_storefront_base` has it, even as `[]` for a leaf component with no child regions.

## 2. Import and set Site Preferences

1. Import [`cartridge/meta/system-objecttype-extensions.xml`](../../cartridge/meta/system-objecttype-extensions.xml) via **Administration → Site Development → Import & Export**. This creates the `ps_*` custom attributes and the **Data Cloud Personalization** preference group — it does not set any values. (A stale comment in `configHelper.js` calls this group "Personalization SCAPI" — the real group id/display name is `D360 Personalization` / "Data Cloud Personalization".)
2. In **Merchant Tools → Site Preferences → Custom Preferences → Data Cloud Personalization**, set for this environment:
   - `ps_enabled` = true
   - `ps_scapiShortCode` (e.g. `jcyuoges`)
   - `ps_scapiOrgId` (e.g. `f_ecom_zzbf_001`)
   - `ps_scapiSiteId` (the SCAPI site id for this site, e.g. `RefArchGlobal`)
   - `ps_scapiClientId` — see §3, this is the value most likely to be missing/blocked
   - `ps_scapiRedirectUri` — any value, as long as it matches what's registered on the SLAS client in §3
   - Optional: `ps_personalizationPointName`, `ps_pointNameMap`, `ps_maxTiles`, `ps_expand`

## 3. SLAS client (public / PKCE)

The `scapi` render mode needs a SLAS **public (PKCE)** client scoped to Shopper Products, with the target storefront's domain in its CORS allow-list:

1. In Account Manager, create or confirm an existing SLAS public (PKCE) client for the org, scoped to Shopper Products.
2. Register a `redirect_uri` on the client (any value — SLAS's guest PKCE exchange never delivers a response there, it just has to be registered). Record it into `ps_scapiRedirectUri`.
3. Record the client id into `ps_scapiClientId`.
4. **Separately, register the storefront domain against SCAPI CORS Preferences** for that `client_id` + site — without this, the browser `fetch()` calls in `personalizationTiles.js` fail CORS preflight and every `scapi`-mode zone renders empty. This is not a setting on the SLAS client itself — it's a call to a distinct SCAPI Admin API (`sfcc.cors-preferences.rw`), made with a different Account Manager API client. **Resolved for sandbox `zzbf-001` / site `RefArch` on 2026-09-21** — see [SCAPI-CORS-Preferences-Investigation.md](../architecture-and-design/SCAPI-CORS-Preferences-Investigation.md) for the exact procedure (including the non-obvious OAuth scope requirement that caused a multi-week 403) to repeat this for another realm/client.

**Separate, still-open blocker — creating a *new* SLAS client via the `b2c` CLI:** `b2c slas client create`/`list` has previously returned 401 ("no access") against org `f_ecom_zzbf_001` — a blanket Account Manager authorization gap for that specific tooling path, tracked in project memory as the `plugin_scapi_search` blocker. This is unrelated to the CORS Preferences issue above and, as of 2026-09-21, still unresolved. It does **not** block this guide's worked example, which reuses an already-existing, already-working SLAS client (`4b131dbc-db20-4632-88c0-16b1a76d870c`) rather than creating a new one — only relevant if you specifically need a *new* SLAS client on this org and the CLI is your only path to create it.

## 4. Build the new Page Designer page

1. **Merchant Tools → Online Marketing → Page Designer → Pages → Create Page.**
2. Choose a page type (a plain Storefront Page is simplest for a standalone test page), give it an ID/name, and add at least one region.
3. Drag **"Personalization Product Recommendations"** (component group: *Personalization*) into the region.
4. Set its attributes:
   - `Render Mode` = **`sfra`** for a fast first test — it needs no SCAPI/SLAS setup and hits the storefront's own `Tile-Show`. `scapi` mode is fully working on sandbox `zzbf-001`/site `RefArch` as of the CORS Preferences fix (§3 above) — switch to it once you've confirmed §2's Site Preferences are set; if CORS Preferences aren't yet registered for your `client_id`/site, `scapi` mode will show the "Preview — SCAPI not yet connected" placeholder tile instead.
   - `Title` (optional headline)
   - `Personalization Point Name` and/or `Context Key` (resolves the point via `ps_pointNameMap` if left blank — see `resolvePointName()` in `configHelper.js`). **The point name must actually be eligible for the page you're placing it on** — see the callout below.
   - `Max Tiles` (optional, falls back to `ps_maxTiles`; enter it as a plain number like `4` — the attribute is a Page Designer `string` type since no numeric type exists, parsed client-side)
5. Save, then Publish the page.

> **Personalization points can be page-scoped.** Data Cloud Personalization "experiences" are matched against page type/URL, so a point name that returns real product ids on one page can return `{"personalizations":[]}` on another, purely because that experience's targeting doesn't include the new page — this looks identical to a broken integration (empty region, zero errors, zero network calls past `GetConfig`) but is a Personalization/Data Cloud admin configuration issue, not a cartridge bug. Confirmed on sandbox `zzbf-001` (2026-09-21): `Generic_Product_Recommendations` (targeted at the homepage) returned zero personalizations on a brand-new standalone Page Designer page, while `SK_Home` — an already page-agnostic/differently-targeted point — worked immediately with the exact same component config. If a point returns empty on a new page, don't debug the cartridge further; ask whoever owns the Personalization/Data Cloud builder to check that point's/experience's page targeting.

## 5. Make the page reachable

- Use the Page Designer editor's own **Preview** to render the page without an assignment, for a fast first look.
- To hit it as a real storefront request, assign the page a URL — depending on how the site is configured this is typically done by assigning the page to a category/folder, or giving it a static URL slug/alias. Confirm the mechanism this sandbox's site uses before assuming a specific path.

## 6. Verify end-to-end

Open DevTools Network tab on the loaded page and confirm, in order:

1. `PersonalizationTiles-GetConfig` — 200, `enabled: true`, all required fields populated (an empty required field means a Site Preference from §2 is missing).
2. `PersonalizationTiles-GetToken` — 200 (same-origin call to this cartridge's own controller, not a direct browser call to SLAS). A failure here points at a misconfigured `ps_scapiClientId`/`ps_scapiRedirectUri`, or a SLAS-side client issue from §3.
3. The SCAPI Shopper Products GET — 200, tiles render with live price/image/promo data.
4. Check the console for `[PersonalizationTiles]` warnings — a decision-API warning is expected until the real Personalization decision call is wired in (see [PersonalizationSCAPI-Design.md §3.7](../architecture-and-design/PersonalizationSCAPI-Design.md#37-open-items-before-production)); anything else indicates a config or CORS problem.

If tiles instead show the "Preview — SCAPI not yet connected" badge, one of the four `ps_scapi*` preferences is still blank — most likely `ps_scapiClientId` from §3.

## 7. Rollback / disable

- Delete or unpublish the Page Designer page — no code or Site Preference changes needed, since the page itself is the only new artifact this guide creates.
- To disable SCAPI hydration storefront-wide without touching this page, flip `ps_enabled` off — the component instance's `<isif condition="${psEnabled}">` guard covers Page Designer placements the same way it covers Content Slots.
