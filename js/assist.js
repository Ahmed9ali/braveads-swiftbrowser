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
