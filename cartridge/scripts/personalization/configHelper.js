/**
 * Helper to read Personalization/SCAPI tile widget configuration from Site Preferences.
 *
 * Site Preferences are configured via Business Manager:
 *   Merchant Tools > Site Preferences > Custom Preferences > Personalization SCAPI
 *
 * Required preferences:
 *   - ps_scapiShortCode (String): SCAPI short code (e.g. "kv7kzm78")
 *   - ps_scapiOrgId (String): Salesforce Commerce API organization id (e.g. "f_ecom_zzrf_001")
 *   - ps_scapiClientId (String): SLAS public (PKCE) client id used for the guest/shopper token.
 *     The token itself is minted server-side (PersonalizationTiles-GetToken, see
 *     scripts/personalization/slasGuestToken.js) since the PKCE authorize/redirect exchange
 *     can't be done from browser JS without a same-origin redirect_uri; only the resulting
 *     Bearer token and subsequent SCAPI product fetches happen client-side.
 *   - ps_scapiSiteId (String): SCAPI site id (e.g. "RefArchGlobal")
 *   - ps_scapiRedirectUri (String): a redirect_uri registered on ps_scapiClientId. Only used
 *     server-side for the PKCE token exchange — SLAS never delivers a response there, so it
 *     does not need to be reachable, only registered on the client in SLAS Admin.
 *
 * Optional preferences:
 *   - ps_personalizationPointName (String): default Salesforce Personalization point/decision
 *     name, used when a slot doesn't specify its own point name and ps_pointNameMap has no
 *     matching entry
 *   - ps_pointNameMap (Text/JSON): optional map resolving a slot's contextKey to a point name,
 *     nested by delivery architecture (see resolvePointName() below for the resolution order)
 *   - ps_expand (String): comma-separated SCAPI expand params (default: "availability,images,prices,promotions,variations")
 *   - ps_maxTiles (Number): max tiles to render per zone (default: 8, also capped by SCAPI's 24-id batch limit)
 *   - ps_enabled (Boolean): enable/disable the whole feature (default: true)
 *   - ps_dcSdkUrl (String): Data Cloud/Salesforce Interactions beacon SDK script URL
 *     (tenant-specific, e.g. "https://cdn.c360a.salesforce.com/beacon/c360a/<org-guid>/scripts/c360a.min.js")
 *   - ps_productIdField (String): field name on each Personalization decision item that holds
 *     the product id (default: "ssot__Id__c" — varies by customer implementation)
 *   - ps_activityTrackingEnabled (Boolean): send "personalization-view"/"personalization-click"
 *     activity events via getSalesforceInteractions().sendEvent() for rendered tiles
 *     (default: true). Has no effect if the Data Cloud SDK never loads (ps_dcSdkUrl unset).
 */

var Site = require('dw/system/Site');
var Logger = require('dw/system/Logger');

/**
 * Branches on defaultValue's type rather than the preference's falsiness, so a legitimate
 * falsy value (ps_maxTiles = 0, ps_enabled = false) isn't mistaken for "unset".
 * @param {string} prefId - The site preference ID
 * @param {*} defaultValue - Fallback value if preference is not set; also determines the
 *   expected type (boolean/number/string) for coercion
 * @returns {*} The preference value or default
 */
function getPreference(prefId, defaultValue) {
    var value = Site.current.getCustomPreferenceValue(prefId);
    if (value === null || value === undefined) {
        return defaultValue;
    }

    if (typeof defaultValue === 'boolean') {
        return typeof value === 'boolean' ? value : !!value.valueOf();
    }

    if (typeof defaultValue === 'number') {
        var num = typeof value === 'number' ? value : value.valueOf();
        return (typeof num === 'number' && !isNaN(num)) ? num : defaultValue;
    }

    var result = value.valueOf();
    return (result === '' || result === 'null') ? defaultValue : result;
}

/**
 * @returns {Object} Widget configuration object consumed by the client-side JS
 */
function getConfig() {
    return {
        shortCode: getPreference('ps_scapiShortCode', ''),
        organizationId: getPreference('ps_scapiOrgId', ''),
        clientId: getPreference('ps_scapiClientId', ''),
        siteId: getPreference('ps_scapiSiteId', ''),
        redirectUri: getPreference('ps_scapiRedirectUri', ''),
        pointName: getPreference('ps_personalizationPointName', 'Generic_Product_Recommendations'),
        expand: getPreference('ps_expand', 'availability,images,prices,promotions,variations'),
        maxTiles: getPreference('ps_maxTiles', 8),
        enabled: getPreference('ps_enabled', true),
        dcSdkUrl: getPreference('ps_dcSdkUrl', 'https://cdn.c360a.salesforce.com/beacon/c360a/91ef8864-1aeb-4ab2-bcae-0e0aba727e84/scripts/c360a.min.js'),
        productIdField: getPreference('ps_productIdField', 'ssot__Id__c'),
        activityTrackingEnabled: getPreference('ps_activityTrackingEnabled', true)
    };
}

/**
 * @returns {boolean} True if all required config is set
 */
function isConfigured() {
    var config = getConfig();
    return !!(config.shortCode && config.organizationId && config.clientId && config.siteId);
}

/**
 * Parses ps_pointNameMap. Malformed JSON must never break rendering — logged and treated as
 * an empty map so resolvePointName() falls through to the site-wide default.
 * @returns {Object} the map's "architectures" object, or {} if unset/invalid
 */
function getPointNameMap() {
    var raw = getPreference('ps_pointNameMap', '');
    if (!raw) {
        return {};
    }

    try {
        var parsed = JSON.parse(raw);
        return (parsed && parsed.architectures) || {};
    } catch (e) {
        Logger.warn('configHelper: ps_pointNameMap is not valid JSON, ignoring it: {0}', e.message);
        return {};
    }
}

/**
 * Resolves the personalization point name for one slot (a plain-include placement or a Page
 * Designer component instance).
 *
 * Resolution order:
 *   1. explicitName — the point name entered directly on the slot, if any
 *   2. architectures[architecture][contextKey] — per-architecture map entry
 *   3. architectures.common[contextKey] — shared map entry across architectures
 *   4. ps_personalizationPointName — site-wide default
 *
 * @param {string} architecture - delivery architecture key, e.g. "sfra" or "pageDesigner"
 * @param {string} [contextKey] - business-user-assigned slot key looked up in ps_pointNameMap
 * @param {string} [explicitName] - point name entered directly on the slot
 * @returns {string} the resolved personalization point name
 */
function resolvePointName(architecture, contextKey, explicitName) {
    if (explicitName) {
        return explicitName;
    }

    if (contextKey) {
        var architectures = getPointNameMap();
        var forArchitecture = architectures[architecture];
        if (forArchitecture && forArchitecture[contextKey]) {
            return forArchitecture[contextKey];
        }
        var common = architectures.common;
        if (common && common[contextKey]) {
            return common[contextKey];
        }
    }

    return getPreference('ps_personalizationPointName', 'Generic_Product_Recommendations');
}

module.exports = {
    getConfig: getConfig,
    isConfigured: isConfigured,
    resolvePointName: resolvePointName
};
