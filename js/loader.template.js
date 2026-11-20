// Swift AdBlock cosmetic filtering for Android WebView.
// A port of Brave's cosmetic_filters_js_handler.cc (ProcessURL / ApplyRules / CSSRulesRoutine /
// OnHiddenClassIdSelectors) wrapped around Brave's own content_cosmetic.ts + procedural_filters.ts
// bundle, which is embedded below at __BUNDLE__.
//
// Runs at document start in every frame. Needs window.__swiftAdblock (Kotlin @JavascriptInterface).
(function () {
  'use strict';
  try {
    // Captcha / bot-check frames inspect the browser for tampering: leave them completely untouched.
    var HN0 = (location.hostname || '').toLowerCase();
    if (/(^|\.)(challenges\.cloudflare\.com|hcaptcha\.com|recaptcha\.net|turnstile\.com)$/.test(HN0) ||
        (HN0 === 'www.google.com' && location.pathname.indexOf('/recaptcha') === 0)) return;
    var bridge = window.__swiftAdblock;
    if (!bridge || window.__swiftAdblockDone) return;
    var pageUrl = location.href;
    if (!/^https?:/.test(pageUrl)) return;
    window.__swiftAdblockDone = true;

    // --- Tunables. Brave reads these from base::Feature params (not in the files provided);
    // values below are reasonable stand-ins. `undefined` disables the behaviour.
    var SUBFRAME_FIRST_SELECTORS_POLLING_DELAY_MS = 1000; // main frame always uses undefined (= start now)
    var SWITCH_TO_SELECTORS_POLLING_THRESHOLD = 1000;
    var FETCH_NEW_CLASS_ID_RULES_THROTTLING_MS = 100;

    /*__ASSIST__*/
    try { if (bridge.assistSpeed(pageUrl) > 1) runAssist(bridge.assistSpeed(pageUrl)); } catch (e) {}

    var isMainFrame = window === window.top;
    var crossOrigin = false;
    if (!isMainFrame) {
      try { void window.top.location.href; } catch (e) { crossOrigin = true; }
    }

    var res;
    try { res = JSON.parse(bridge.cosmetic(pageUrl, crossOrigin)); } catch (e) { return; }
    if (!res || typeof res !== 'object' || res.disabled) return;   // Shields off / exempt page

    // enabled_1st_party_cf_ in Brave: aggressive mode, cross-origin frame, or youtube.com.
    // When true, rules hide everything they match (no "is this first-party content?" check).
    var aggressive = !!res.aggressive;
    var generichide = !!res.generichide;
    var vetted = !!res.vetted_search_engine;
    var exceptions = res.exceptions || [];
    var hideSelectors = res.hide_selectors || [];

    // ------------------------------------------------------------------ cf_worker shim
    // Functions content_cosmetic.ts expects (bound in C++ by BindFunctionsToObject()).
    var injectedSheet = null;
    var injectedCss = [];
    function attachSheet(sheet) {
      try {
        if (document.adoptedStyleSheets.indexOf(sheet) === -1) {
          document.adoptedStyleSheets = [sheet].concat(Array.from(document.adoptedStyleSheets));
        }
      } catch (e) {}
    }
    // Constructable stylesheets are exempt from page CSP (<style> elements are not).
    function injectStylesheet(css) {
      if (!css) return;
      try {
        if (!injectedSheet) injectedSheet = new CSSStyleSheet();
        injectedCss.push(css);
        injectedSheet.replaceSync(injectedCss.join('\n'));
        attachSheet(injectedSheet);
      } catch (e) {}
    }

    function isFirstPartyUrl(url) {
      var resolved;
      try { resolved = new URL(url, pageUrl).href; } catch (e) { return false; }
      return !!bridge.isFirstParty(resolved, pageUrl);
    }

    // OnHiddenClassIdSelectors(): called by content_cosmetic.ts with new classes/ids.
    function hiddenClassIdSelectors(input) {
      if (generichide) return;
      var parsed;
      try { parsed = JSON.parse(input); } catch (e) { return; }
      var selectors;
      try {
        selectors = JSON.parse(bridge.hidden(
          JSON.stringify(parsed.classes || []),
          JSON.stringify(parsed.ids || []),
          JSON.stringify(exceptions)));
      } catch (e) { return; }
      if (!selectors || !selectors.length) return;
      if (!aggressive && vetted) return;
      if (aggressive) {
        injectStylesheet(selectors.map(function (s) { return s + '{display:none !important}'; }).join(''));
      } else {
        injectHideSelectors(selectors);
        tryEntryPoint();
      }
    }

    window.cf_worker = window.cf_worker || {
      hiddenClassIdSelectors: hiddenClassIdSelectors,
      isFirstPartyUrl: isFirstPartyUrl,
      injectStylesheet: injectStylesheet
    };

    // ------------------------------------------------------------------ handler logic
    window.content_cosmetic = window.content_cosmetic || {};
    var CC = window.content_cosmetic;

    // kHideSelectorsInjectScript
    function injectHideSelectors(selectors) {
      var CCx = window.content_cosmetic;
      var nextIndex = CCx.cosmeticStyleSheet ? CCx.cosmeticStyleSheet.rules.length : 0;
      if (!CCx.cosmeticStyleSheet) return; // bundle not executed yet
      selectors.forEach(function (selector) {
        if (typeof selector === 'string' &&
            (CCx.hide1pContent || !CCx.allSelectorsToRules.has(selector))) {
          var rule = selector + '{display:none !important;}';
          try {
            CCx.cosmeticStyleSheet.insertRule(rule, nextIndex);
            if (!CCx.hide1pContent) {
              CCx.allSelectorsToRules.set(selector, nextIndex);
              CCx.firstRunQueue.add(selector);
            }
            nextIndex++;
          } catch (e) { /* invalid selector for this engine: ignore, like Brave */ }
        }
      });
      attachSheet(CCx.cosmeticStyleSheet);
    }

    var bundleInjected = false;
    function runBundle() {
      /*__BUNDLE__*/
    }
    // ExecuteObservingBundleEntryPoint()
    function tryEntryPoint() {
      if (!bundleInjected) {
        bundleInjected = true;
        runBundle(); // the bundle calls tryScheduleQueuePump() itself on first run
        return;
      }
      try { window.content_cosmetic.tryScheduleQueuePump(); } catch (e) {}
    }

    // 1. Scriptlets (kScriptletInitScript): inject a <script>, then remove it.
    if (res.scriptlet) {
      var scriptletBlocked = false;
      document.addEventListener('securitypolicyviolation', function (ev) {
        // Strict page CSP refused our inline script: ask Kotlin to run it via evaluateJavascript
        // (top frame only; evaluateJavascript is not subject to the page CSP).
        if (scriptletBlocked || !isMainFrame) return;
        if (String(ev.violatedDirective || '').indexOf('script-src') !== 0) return;
        scriptletBlocked = true;
        try { bridge.runScriptletFallback(pageUrl); } catch (e) {}
      }, true);
      var runScriptlet = function () {
        var script;
        try {
          script = document.createElement('script');
          script.appendChild(document.createTextNode(res.scriptlet));
          (document.head || document.documentElement).appendChild(script);
        } catch (e) {}
        if (script) {
          if (script.parentNode) script.parentNode.removeChild(script);
          script.textContent = '';
        }
      };
      if (document.documentElement) runScriptlet();
      else {
        var sw = new MutationObserver(function () {
          if (document.documentElement) { sw.disconnect(); runScriptlet(); }
        });
        sw.observe(document, { childList: true });
      }
    }

    // 2. kPreInitScript + kCosmeticFilteringInitScript
    if (CC.hide1pContent === undefined) CC.hide1pContent = aggressive;
    if (CC.generichide === undefined) CC.generichide = generichide;
    if (CC.firstSelectorsPollingDelayMs === undefined)
      CC.firstSelectorsPollingDelayMs = isMainFrame ? undefined : SUBFRAME_FIRST_SELECTORS_POLLING_DELAY_MS;
    if (CC.switchToSelectorsPollingThreshold === undefined)
      CC.switchToSelectorsPollingThreshold = SWITCH_TO_SELECTORS_POLLING_THRESHOLD;
    if (CC.fetchNewClassIdRulesThrottlingMs === undefined)
      CC.fetchNewClassIdRulesThrottlingMs = FETCH_NEW_CLASS_ID_RULES_THROTTLING_MS;

    // 3. Procedural actions (kProceduralActionsScript in cosmetic_filters_resources.cc)
    var proc = res.procedural_actions || [];
    if (proc.length) {
      try {
        var stylesheet = '';
        var takeStyleFilter = function (filter) {
          if (filter.selector.length === 1 && filter.selector[0].type === 'css-selector' &&
              filter.action && filter.action.type === 'style') {
            stylesheet += filter.selector[0].arg + '{' + filter.action.arg + '}\n';
            return false;
          }
          return true; // procedural filtering enabled
        };
        CC.proceduralActionFilters = JSON.parse('[' + proc.join(',') + ']').filter(takeStyleFilter);
        CC.hasProceduralActions = CC.proceduralActionFilters.length > 0;
        if (stylesheet) injectStylesheet(stylesheet);
      } catch (e) {}
    }

    // 4. Observing bundle (content_cosmetic.ts + procedural_filters.ts)
    tryEntryPoint();

    // 5. CSSRulesRoutine
    var list = (vetted && !aggressive) ? [] : hideSelectors;
    if (list.length) {
      if (aggressive) {
        injectStylesheet(list.map(function (s) { return s + '{display:none !important}'; }).join(''));
      } else {
        injectHideSelectors(list);
      }
    }
    if (!aggressive) tryEntryPoint();
  } catch (e) { /* never break the page */ }
})();
