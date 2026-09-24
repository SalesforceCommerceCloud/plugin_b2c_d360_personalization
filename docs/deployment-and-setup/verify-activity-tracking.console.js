/* eslint-disable */
/**
 * Browser DevTools console script — manual verification aid for the
 * "personalization-view" / "personalization-click" activity tracking events
 * sent by cartridge/static/default/js/personalizationTiles.js via
 * getSalesforceInteractions().sendEvent().
 *
 * This is a TEST-ONLY tool. It is not app code, is never loaded by the
 * storefront, and must be re-pasted after every page reload.
 *
 * ---------------------------------------------------------------------------
 * SETUP
 * ---------------------------------------------------------------------------
 * 1. Prerequisite: the feature must actually be deployed + enabled first.
 *    Confirm by hitting PersonalizationTiles-GetConfig directly and checking
 *    the response includes "activityTrackingEnabled": true. If that key is
 *    missing entirely, the cartridge code hasn't been uploaded/activated on
 *    this sandbox yet (metadata import and code deploy are separate steps —
 *    see the Setup & Deployment Slack Canvas, Part 1: Code Deployment & Cartridge Path).
 *
 * 2. Open the storefront page you want to verify (e.g. homepage) in a
 *    browser with DevTools open, but do NOT load the page yet.
 *
 * 3. Paste this entire script into the Console tab IMMEDIATELY after hitting
 *    Enter on the URL — ideally before the tiles visibly render. The
 *    personalization-view burst fires once per rendered tile as soon as the
 *    zone finishes hydrating, so pasting late means you'll only catch
 *    personalization-click events (which is fine if that's all you need).
 *
 * 4. A small dark panel appears pinned to the top-right of the page. Every
 *    matched sendEvent() call shows up there as a timestamped line:
 *      - blue left border  = personalization-view
 *      - orange left border = personalization-click
 *
 * 5. Click a product tile to test click tracking. This script blocks the
 *    tile's default navigation (to the PDP) so the page — and the panel —
 *    stays put long enough to see the flash. It does NOT stop event
 *    propagation, so personalizationTiles.js's own click listener (which
 *    actually calls sendEvent) still runs normally.
 *
 * 6. Every captured interaction is also collected in window.__psTrackedEvents.
 *    At any point, run this in the console for a sortable table:
 *      console.table(window.__psTrackedEvents)
 *
 * 7. When done verifying, just reload the page — this removes the
 *    navigation blocker and the wrapped sendEvent along with everything
 *    else this script injected. There is nothing to "uninstall".
 * ---------------------------------------------------------------------------
 */
(function () {
    window.__psTrackedEvents = window.__psTrackedEvents || [];

    var panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;top:10px;right:10px;z-index:999999;max-width:420px;'
        + 'max-height:80vh;overflow:auto;background:#111;color:#0f0;font:12px monospace;'
        + 'padding:10px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.5);';
    panel.innerHTML = '<b style="color:#fff">PS Tracking Events</b><hr style="border-color:#333">';
    document.body.appendChild(panel);

    function flash(name, interaction) {
        var row = document.createElement('div');
        row.style.cssText = 'margin-bottom:6px;padding:6px;background:#1c1c1c;border-left:3px solid '
            + (name === 'personalization-click' ? '#f80' : '#0af') + ';';
        row.textContent = new Date().toLocaleTimeString() + ' — ' + JSON.stringify(interaction);
        panel.appendChild(row);
        row.scrollIntoView();
    }

    function wrap() {
        var interactions = window.getSalesforceInteractions && window.getSalesforceInteractions();
        if (!interactions || typeof interactions.sendEvent !== 'function' || interactions.sendEvent.__psWrapped) {
            return false;
        }
        var original = interactions.sendEvent;
        var wrapped = function (payload) {
            var name = payload && payload.interaction && payload.interaction.name;
            if (name === 'personalization-view' || name === 'personalization-click') {
                window.__psTrackedEvents.push(payload.interaction);
                flash(name, payload.interaction);
            }
            return original.apply(this, arguments);
        };
        wrapped.__psWrapped = true;
        interactions.sendEvent = wrapped;
        flash('wrapped', { status: 'sendEvent wrapped, watching...' });
        return true;
    }

    // SDK global may not exist yet when this script is pasted early — poll for up to ~10s.
    if (!wrap()) {
        var tries = 0;
        var poll = setInterval(function () {
            tries += 1;
            if (wrap() || tries > 100) clearInterval(poll);
        }, 100);
    }

    // Capture phase, runs before the tile's own bubble-phase click listener. Only blocks the
    // anchor's default navigation (no stopPropagation), so the app's real click handler —
    // and the sendEvent call it makes — still fires normally; this just keeps the page (and
    // the panel above) alive long enough to see the resulting flash.
    document.addEventListener('click', function (event) {
        var anchor = event.target.closest && event.target.closest('a');
        if (anchor && anchor.closest('[data-pid]')) {
            event.preventDefault();
            console.log('[PS TRACKING] navigation blocked for verification.');
        }
    }, true);
})();
