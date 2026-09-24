'use strict';

var Template = require('dw/util/Template');
var HashMap = require('dw/util/HashMap');
var configHelper = require('*/cartridge/scripts/personalization/configHelper');

/**
 * Render logic for the personalization.productRecommendations Page Designer component.
 * Per-instance attributes override the site-wide ps_* preferences where set; the client-side
 * JS (personalizationTiles.js) reads the overrides via data-ps-* attributes on the zone element.
 * @param {dw.experience.ComponentScriptContext} context The Component script context object.
 * @returns {string} The rendered component markup
 */
module.exports.render = function (context) {
    var content = context.content;
    var model = new HashMap();

    model.psEnabled = configHelper.getConfig().enabled;
    model.componentId = context.component.getID();
    model.title = content.title || '';
    model.maxTiles = content.maxTiles || '';
    model.pointName = configHelper.resolvePointName('pageDesigner', content.contextKey, content.personalizationPointName);
    // Whitelisted rather than trusted verbatim so a blank/unexpected value can never break
    // rendering — mirrors the same defensive pattern configHelper uses for its preferences.
    model.renderMode = (content.renderMode === 'sfra') ? 'sfra' : 'scapi';

    return new Template('experience/components/personalization/productRecommendations').render(model).text;
};
