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

    // Shortlink assist (per-site, opt-in): neutralises the client-side checks shorteners use to force
// you to look at ads. Runs in the page's main world at document start.
//   1. focus/visibility spoof   -> "stay on this tab" / "tab was hidden" checks pass
//   2. timers + clock speed-up  -> countdowns finish ~N times faster
//   3. window.open stub         -> "click the ad" popups don't open, and scripts see a closed window
// It cannot beat waits that the SERVER measures (token + elapsed time checked on their backend).
function runAssist(SPEED) {
  var N = SPEED > 1 ? SPEED : 10;
  var def = function (o, k, getter) { try { Object.defineProperty(o, k, { get: getter, configurable: true }); } catch (e) {} };

  // 1. focus / visibility
  def(document, 'hidden', function () { return false; });
  def(document, 'webkitHidden', function () { return false; });
  def(document, 'visibilityState', function () { return 'visible'; });
  document.hasFocus = function () { return true; };
  ['blur', 'visibilitychange', 'webkitvisibilitychange', 'pagehide', 'focusout', 'mouseleave'].forEach(function (t) {
    [window, document].forEach(function (target) {
      target.addEventListener(t, function (e) { e.stopImmediatePropagation(); }, true);
    });
  });

  // 2. clock + timers (consistent, so countdowns based on either ticks or Date diffs both speed up)
  var realDateNow = Date.now.bind(Date);
  var realPerfNow = performance.now.bind(performance);
  var t0 = realDateNow(), p0 = realPerfNow();
  var fastNow = function () { return t0 + (realDateNow() - t0) * N; };
  Date.now = fastNow;
  performance.now = function () { return p0 + (realPerfNow() - p0) * N; };
  var RealDate = Date;
  window.Date = new Proxy(RealDate, {
    construct: function (target, args) { return args.length ? new target(...args) : new target(fastNow()); },
    apply: function () { return new RealDate(fastNow()).toString(); }
  });
  var rst = window.setTimeout, rsi = window.setInterval;
  window.setTimeout = function (fn, d) {
    var rest = Array.prototype.slice.call(arguments, 2);
    d = +d || 0;
    if (d >= 1000) d = Math.max(50, d / N);   // leave short UI timers alone
    return rst.apply(this, [fn, d].concat(rest));
  };
  window.setInterval = function (fn, d) {
    var rest = Array.prototype.slice.call(arguments, 2);
    d = +d || 0;
    if (d >= 500) d = Math.max(50, d / N);
    return rsi.apply(this, [fn, d].concat(rest));
  };

  // 3. popups / "click the ad" windows
  var stub = {
    closed: true, focus: function () {}, blur: function () {}, close: function () {},
    postMessage: function () {}, location: { href: 'about:blank', replace: function () {} },
    document: { write: function () {}, writeln: function () {}, close: function () {}, open: function () {} }
  };
  window.open = function () { return stub; };
}

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
      (()=>{var u=window,f=e=>e instanceof HTMLElement?e:null,F=e=>{let t=e.split("/"),r=t[1],o=t[2];return new u.RegExp(r,o)},w=(e,t,r=!1)=>e[0]==="/"?t.match(F(e))!==null:e===""?t.trim()==="":r?t===e:t.includes(e),X=e=>{let o=e[0]==='"',[n,s]=o?['"=',1]:["=",0],i=e.indexOf(n,s);if(i===-1){let d=e;if(o){if(!e.endsWith('"'))throw new Error(`Quoted value '${e}' does not terminate with quote`);d=e.slice(1,e.length-1)}return[d,void 0]}let a=e.slice(s,i),c=i+n.length;return[a,c]},v=(e,t=!1,r=0)=>{let o=_(e,t,r);return w.bind(void 0,o)},_=(e,t=!1,r=0)=>{let o=e[r]==='"',n;if(o){if(e.at(-1)!=='"')throw new Error(`Unable to parse value rule from ${e}. Value rule starts with " but doesn't end with "`);r+=1,n=e.length-1}else n=e.length;let s=e.slice(r,n);return t&&(s=s.replace(/\P{ASCII}/gu,i=>encodeURIComponent(i))),s},Q=e=>{let[t,r]=X(e),o=s=>w(t,s,!0),n;if(r!==void 0){let s=_(e,!1,r);n=i=>w(s,i,!0)}return[o,n]},Z=e=>{let t=e.split(":");if(t.length!==2)throw Error(`Unexpected format for a CSS rule: ${e}`);return[t[0].trim(),t[1].trim()]},ee=e=>{if(!e.parentNode)return[];let t=Array.from(e.parentNode.children),r=[];for(let o of t){if(o===e)continue;let n=f(o);n!==null&&r.push(n)}return r},te=e=>{if(!e.parentNode)return null;let t=u.Array.from(e.parentNode.children),r=t.indexOf(e),o=t[r+1];return o===void 0?null:f(o)},re=e=>u.Array.from(e.children).map(t=>f(t)).filter(t=>t!==null),ne=e=>u.Array.from(e.querySelectorAll(":scope *")).map(t=>f(t)).filter(t=>t!==null),M=(e,t)=>{if(t[0]!==e)throw new Error(`Expected to find ${e} in initial position of "${t}`);return t.replace(e,"").trimStart()},oe=(e,t)=>{let r=e.trimStart();if(r.startsWith("+")){let o=M("+",r);if(o===null)return[];let n=te(t);return n===null?[]:n.matches(o)?[n]:[]}else if(r.startsWith("~")){let o=M("~",r);return o===null?[]:ee(t).filter(s=>s.matches(o))}else if(r.startsWith(">")){let o=M(">",r);return o===null?[]:re(t).filter(s=>s.matches(o))}else if(e.startsWith(" "))return Array.from(t.querySelectorAll(":scope "+r));return t.matches(e)?[t]:[]},se=(e,t)=>t.matches(e)?[t]:[],le=(e,t)=>{let o=e[0]?.type!=="css-selector"?ne(t):[t];return q(e,o).length===0?[]:[t]},ie=(e,t)=>u.Array.isArray(e)?le(e,t):se(e,t),x=(e,t)=>{let r=t.innerText;return v(e)(r)?[t]:[]},ae=(e,t)=>t.matches(e)?[]:[t],ue=(e,t)=>q(e,[t]).length===0?[t]:[],ce=(e,t)=>Array.isArray(e)?ue(e,t):ae(e,t),de=(e,t)=>{let[r,o]=Q(e);for(let[n,s]of Object.entries(t))if(r(n)&&!(o!==void 0&&!o(s)))return[t];return[]},fe=(e,t)=>{let r=+e;if(r===u.NaN)throw new Error(`min-text-length: Invalid arg, ${e}`);return t.innerText.trim().length>=r?[t]:[]},me=(e,t)=>{let[r,o]=Q(e);for(let n of t.getAttributeNames()){if(!r(n))continue;let s=t.getAttribute(n);if(!(s===null||o!==void 0&&!o(s)))return[t]}return[]},P=(e,t,r)=>{let[o,n]=Z(t),i=u.getComputedStyle(r,e).getPropertyValue(o);if(i===void 0)return[];let a;return n.startsWith("/")&&n.endsWith("/")?a=i.match(F(n))!==null:a=n===i,a?[r]:[]},he=(e,t)=>u.matchMedia(e).matches?[t]:[],pe=(e,t)=>{let r=u.location.pathname+u.location.search;return v(e,!0)(r)?[t]:[]},ge=(e,t)=>{if(e<1||e>=256)throw new Error(`upward: invalid arg, ${e}`);let r=t;for(;r!==null&&e>0;)r=r.parentNode,e-=1;if(r===null)return[];{let o=f(r);return o===null?[]:[o]}},Se=(e,t)=>{let r=S(e),o=t;for(;o!==null;){let n=f(o);if(n===null)break;if(y(r,[n]).length!==0)return[n];o=n.parentNode}return[]},ye=(e,t)=>{let r=t;for(;r!==null;){let o=f(r);if(o===null)break;if(o.matches(e))return[o];r=o.parentNode}return[]},Te=(e,t)=>u.Number.isInteger(+e)?ge(+e,t):u.Array.isArray(e)?Se(e,t):ye(e,t),k=(e,t)=>{let r=u.document.evaluate(e,t,null,u.XPathResult.UNORDERED_NODE_ITERATOR_TYPE,null),o=[],n;for(;n=r.iterateNext();){let s=f(n);s!==null&&o.push(s)}return o},be={contains:x,"css-selector":oe,has:ie,"has-text":x,"matches-attr":me,"matches-css":P.bind(void 0,null),"matches-css-after":P.bind(void 0,"::after"),"matches-css-before":P.bind(void 0,"::before"),"matches-media":he,"matches-path":pe,"matches-property":de,"min-text-length":fe,not:ce,upward:Te,xpath:k},S=e=>{let t=[];for(let r of e){let o=be[r.type],n=[r.arg];if(o===void 0)throw new Error(`Not sure what to do with operator of type ${r.type}`);t.push({type:r.type,func:o.bind(void 0,...n),args:n})}return t},Ee=["matches-media","matches-path"],Me=(e,t)=>{let r=[],o=0,n=e[0],s=n.type,i=n.args[0];if(t!==void 0)r=u.Array.from(t);else if(s==="css-selector"){let a=i;r=u.Array.from(u.document.querySelectorAll(a)),o+=1}else s==="xpath"?(r=k(i,u.document.documentElement),o+=1):r=u.Array.from(u.document.all).filter(f);return[o,r]},y=(e,t)=>{let r=Me(e,t),[o,n]=r,s=e.length;for(o;n.length>0&&o<s;++o){let i=e[o],a=i.func,c=i.type;if(Ee.includes(c)){let m=n[0];a(m).length===0&&(n=[]);continue}let d=[];for(let m of n){let G=a(m);d=d.concat(G)}n=d}return n},q=(e,t)=>{let r=S(e);return y(r,t)};var Pe=2500,we=30,Re=5,Ae=1e4,Ce=500,T,R=0,Oe=1e3,W=performance.now(),D=0,A,V=()=>{let e=Number.parseInt("a000000000",36),t=Number.parseInt("zzzzzzzzzz",36);return Math.floor(Math.random()*(t-e)+e).toString(36)},C=V(),U=new Map,b=new Set,E=new Set,g=[],$="[id]:not(html):not(body),[class]:not(html):not(body)",h=[],p=[];window.content_cosmetic=window.content_cosmetic||{};var l=window.content_cosmetic;l.cosmeticStyleSheet=l.cosmeticStyleSheet||new CSSStyleSheet;l.allSelectorsToRules=l.allSelectorsToRules||new Map;l.observingHasStarted=l.observingHasStarted||!1;l.firstRunQueue=l.firstRunQueue||new Set;l.secondRunQueue=l.secondRunQueue||new Set;l.finalRunQueue=l.finalRunQueue||new Set;l.allQueues=l.allQueues||[l.firstRunQueue,l.secondRunQueue,l.finalRunQueue];l.numQueues=l.numQueues||l.allQueues.length;l.alreadyUnhiddenSelectors=l.alreadyUnhiddenSelectors||new Set;l.alreadyKnownFirstPartySubtrees=l.alreadyKnownFirstPartySubtrees||new WeakSet;l._hasDelayOcurred=l._hasDelayOcurred||!1;l._startCheckingId=l._startCheckingId||void 0;l.firstSelectorsPollingDelayMs=l.firstSelectorsPollingDelayMs||void 0;l.switchToSelectorsPollingThreshold=l.switchToSelectorsPollingThreshold||void 0;l.fetchNewClassIdRulesThrottlingMs=l.fetchNewClassIdRulesThrottlingMs||void 0;var Le=(e,t)=>{let r;return function(){r===void 0&&(r=window.requestIdleCallback(()=>{r=void 0,e()},{timeout:t}))}},Ie=e=>!e.startsWith("//")&&!e.startsWith("http://")&&!e.startsWith("https://"),Ne=e=>e.nodeType===1,He=e=>Ne(e)?e:null,xe=e=>"innerText"in e,Fe=()=>{if(l.fetchNewClassIdRulesThrottlingMs===void 0)return!1;if(A)return!0;let e=performance.now(),t=D-e;return t>0?(A=window.setTimeout(()=>{A=void 0,N()},t),!0):(D=e+l.fetchNewClassIdRulesThrottlingMs,!1)},B=e=>{let t=e.id;t&&!b.has(t)&&(p.push(t),b.add(t));for(let r of e.classList.values())r&&!E.has(r)&&(h.push(r),E.add(r))},N=()=>{for(let e of g)for(let t of e)B(t);g.length=0,!((!h||h.length===0)&&(!p||p.length===0))&&(cf_worker.hiddenClassIdSelectors(JSON.stringify({classes:h,ids:p})),h=[],p=[])},Y=()=>{T&&(clearInterval(T),T=void 0);let e=new MutationObserver(Qe),t={subtree:!0,childList:!0,attributeFilter:["id","class"]};e.observe(document.documentElement,t)},ve=e=>{e&&(e.disconnect(),g.length=0);let t=window.Date.now()+Ae,r=j.bind(void 0,t);T=window.setInterval(r,Ce)},_e=e=>{let t=0;for(let r of e)if(r.type==="attributes"){let o=r.target;switch(r.attributeName){case"class":t+=o.classList.length;for(let s of o.classList.values())E.has(s)||(h.push(s),E.add(s));break;case"id":let n=o.id;t++,b.has(n)||(p.push(n),b.add(n));break}}else if(r.addedNodes.length>0)for(let o of r.addedNodes){let n=He(o);if(n&&(g.push([n]),t+=1,n.firstElementChild!==null)){let s=n.querySelectorAll($);g.push(s),t+=s.length}}return t},Qe=(e,t)=>{let r=cf_worker.onHandleMutationsBegin?.(),o=_e(e);if(l.switchToSelectorsPollingThreshold!==void 0){let n=performance.now();n>W+Oe&&(W=n,R=0),R+=o,R>l.switchToSelectorsPollingThreshold&&ve(t)}if(!l.generichide&&!Fe()&&N(),l.hasProceduralActions){let n=[];e.forEach(s=>s.addedNodes.length!==0&&s.addedNodes.forEach(i=>{if(i.nodeType===Node.ELEMENT_NODE){n.push(i);let a=i.querySelectorAll("*");a.length!==0&&a.forEach(c=>{c.nodeType===Node.ELEMENT_NODE&&n.push(c)})}})),n.length!==0&&H(n)}r&&cf_worker.onHandleMutationsEnd(r)},ke=e=>Ie(e)?!0:cf_worker.isFirstPartyUrl(e),qe=(e,t,r)=>{let o=Array.from(e.getElementsByTagName(t)),n=r;for(let s of o)n=n.replaceAll(s.innerText,"");return n},We=e=>{if(!xe(e))return!1;let t=e,r=["script","style"],o=t.innerText;for(let i of r)o=qe(t,i,o);let n=o.trim();if(n.length<we)return!1;let s=0;for(let i of n.split(" "))i.trim().length!==0&&(s+=1);return s>=Re},L=(e,t)=>{let r,o;if(t?(r=t,o=!1):(r={foundFirstPartyResource:!1,foundThirdPartyResource:!1,foundKnownThirdPartyAd:!1},o=!0),e.getAttribute){if(e.hasAttribute("id")){let n=e.getAttribute("id");if(n.startsWith("google_ads_iframe_")||n.startsWith("div-gpt-ad")||n.startsWith("adfox_"))return r.foundKnownThirdPartyAd=!0,!1}if(e.hasAttribute("src")){let n=e.getAttribute("src");if(ke(n))return r.foundFirstPartyResource=!0,!0;r.foundThirdPartyResource=!0}if(e.hasAttribute("style")){let n=e.getAttribute("style");(n.includes("url(")||n.includes("//"))&&(r.foundThirdPartyResource=!0)}e.hasAttribute("srcdoc")&&e.getAttribute("srcdoc").trim()===""&&(r.foundThirdPartyResource=!0)}if(e.firstChild){if(L(e.firstChild,r),r.foundKnownThirdPartyAd)return!1;if(r.foundFirstPartyResource)return!0}if(e.nextSibling){if(L(e.nextSibling,r),r.foundKnownThirdPartyAd)return!1;if(r.foundFirstPartyResource)return!0}return!r.foundThirdPartyResource},De=e=>{if(e.size===0)return;let t=Array.from(e).map(s=>l.allSelectorsToRules.get(s)).filter(s=>s!==void 0).sort().reverse(),r=l.allSelectorsToRules.size-1;for(let s of t)l.cosmeticStyleSheet.deleteRule(s);let o=Array.from(l.allSelectorsToRules.entries()),n=t.length;for(let s=r;s>0;s--){let[i,a]=o[s];if(t.includes(s)){if(l.allSelectorsToRules.delete(i),n--,n===0)break;continue}a!==s&&console.error("Cosmetic Filters: old index did not match lookup index",{selector:i,oldIdx:a,i:s}),l.allSelectorsToRules.set(i,a-n)}},Ue=40,ze=1e3,Ke=60,O=!1,Ve=()=>{if(O)return;let e=!1;for(let t=0;t<l.numQueues;t+=1){let r=l.allQueues[t],o=l.allQueues[t+1];if(r.size===0)continue;let n=Array.from(r.values()).slice(0,Ke),s=n.join(","),i=document.querySelectorAll(s),a=new Set;for(let c of i)if(!(l.alreadyKnownFirstPartySubtrees.has(c)||!(L(c)||We(c)))){for(let m of n)c.matches(m)&&(l.alreadyUnhiddenSelectors.has(m)||(a.add(m),l.alreadyUnhiddenSelectors.add(m)));l.alreadyKnownFirstPartySubtrees.add(c)}De(a);for(let c of n){r.delete(c);let d=a.has(c);o&&!d&&o.add(c)}e=!0;break}e&&(O=!0,window.setTimeout(()=>{O=!1,I()},Ue))},I=Le(Ve,ze),j=e=>{let t=cf_worker.onQuerySelectorsBegin?.();if(!l.generichide){let r=document.querySelectorAll($);for(let o of r)B(o);N()}l.hasProceduralActions&&H(),t&&cf_worker.onQuerySelectorsEnd(t),e!==void 0&&window.Date.now()>=e&&Y()},z=()=>{j(),Y()},K=(e,t)=>{if(l._hasDelayOcurred){I();return}l._startCheckingId===void 0&&(l._startCheckingId=window.requestIdleCallback(r=>{l._hasDelayOcurred=!0,(!t||l.hasProceduralActions)&&(l.firstSelectorsPollingDelayMs===void 0?z():window.setTimeout(z,l.firstSelectorsPollingDelayMs)),e||I()},{timeout:Pe}))},J=()=>{l.observingHasStarted?K(!1,!1):(l.observingHasStarted=!0,K(l.hide1pContent,l.generichide))};l.tryScheduleQueuePump=l.tryScheduleQueuePump||J;J();var H=e=>{if(l.proceduralActionFilters===void 0)return;let t=o=>{let n=U.get(o);if(n===void 0){n=V(),U.set(o,n);let s=`[${C}][${n}]{${o}}`;cf_worker.injectStylesheet(s)}return n},r=(o,n)=>{if(n===void 0){let s=t("display: none !important");o.setAttribute(C,""),o.setAttribute(s,"")}else if(n.type==="style"){let s=t(n.arg);o.setAttribute(C,""),o.setAttribute(s,"")}else n.type==="remove"?o.remove():n.type==="remove-attr"?o.removeAttribute(n.arg):n.type==="remove-class"&&o.classList.contains(n.arg)&&o.classList.remove(n.arg)};for(let{selector:o,action:n}of l.proceduralActionFilters)try{let s,i;if(o[0].type==="css-selector"&&e===void 0?(s=document.querySelectorAll(o[0].arg),i=1):e===void 0?(s=document.querySelectorAll("*"),i=0):(s=e,i=0),i===o.length)s.forEach(a=>r(a,n));else{let a=S(o.slice(i));y(a,s).forEach(c=>r(c,n))}}catch(s){console.error("Failed to apply filter "+JSON.stringify(o)+" "+JSON.stringify(n)+": "),console.error(s.message),console.error(s.stack)}};l.hasProceduralActions&&H();})();
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
