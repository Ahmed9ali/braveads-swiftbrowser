#!/usr/bin/env python3
"""Adds the ad-library stand-in (googletag / adsbygoogle) to blockedResponse() in MainActivity.kt.
Run from the repo root:  python3 apply_stub_patch.py   (optional arg: path to MainActivity.kt). Backup: .bak2"""
import re, sys
from pathlib import Path
path = Path(sys.argv[1] if len(sys.argv) > 1 else "app/src/main/java/com/swift/browser/MainActivity.kt")
src = path.read_text(encoding="utf-8")
if "AD_LIB_STUB" in src:
    print("Already patched."); sys.exit(0)
def rx(t): return re.compile(r"\s+".join(re.escape(p) for p in t.split()))
old = '''path.endsWith(".js") || path.endsWith(".mjs") ->
            return WebResourceResponse(
                "application/javascript", "utf-8", 200, "OK", cors,
                java.io.ByteArrayInputStream("/* blocked by Swift Shields */".toByteArray())
            )'''
new = '''path.endsWith(".js") || path.endsWith(".mjs") -> {
            // Ad libraries that pages call into: answer with a harmless stand-in so the page's own scripts do not crash.
            val stub = if (path.endsWith("/gpt.js") || path.contains("pubads") || path.contains("adsbygoogle") ||
                path.contains("/show_ads") || path.contains("/ima3"))
                AD_LIB_STUB else "/* blocked by Swift Shields */"
            return WebResourceResponse(
                "application/javascript", "utf-8", 200, "OK", cors,
                java.io.ByteArrayInputStream(stub.toByteArray())
            )
        }'''
const = '''private const val AD_LIB_STUB = """(function(w){try{
var noop=function(){return this;};
var slot={addService:noop,setTargeting:noop,setCollapseEmptyDiv:noop,defineSizeMapping:noop,setClickUrl:noop,set:noop,get:function(){return null;},getSlotElementId:function(){return '';},updateTargetingFromMap:noop};
var ps={enableSingleRequest:noop,enableLazyLoad:noop,collapseEmptyDivs:noop,disableInitialLoad:noop,refresh:noop,setTargeting:noop,addEventListener:noop,removeEventListener:noop,setPrivacySettings:noop,set:noop,get:function(){return null;},clear:noop,enableServices:noop,getSlots:function(){return [];}};
var g=w.googletag=w.googletag||{};
g.cmd=g.cmd||[];g.apiReady=true;g.pubadsReady=true;
g.defineSlot=function(){return slot;};g.defineOutOfPageSlot=function(){return slot;};g.display=noop;g.destroySlots=function(){return true;};
g.pubads=function(){return ps;};g.companionAds=function(){return ps;};g.enableServices=noop;g.sizeMapping=function(){return {addSize:noop,build:function(){return [];}};};
g.cmd.push=function(f){try{typeof f==='function'&&f();}catch(e){}return 1;};
var q=g.cmd.splice?g.cmd.slice():[];q.forEach(function(f){try{typeof f==='function'&&f();}catch(e){}});
w.adsbygoogle=w.adsbygoogle||[];if(!w.adsbygoogle.loaded){w.adsbygoogle.loaded=true;w.adsbygoogle.push=function(){return 1;};}
}catch(e){}})(window);"""

'''
a = list(rx(old).finditer(src)); b = list(rx("private fun blockedResponse(url: String): WebResourceResponse {").finditer(src))
if len(a) != 1 or len(b) != 1:
    print("ERROR: anchors not found exactly once; nothing changed."); sys.exit(1)
out = src[:a[0].start()] + new + src[a[0].end():]
m = rx("private fun blockedResponse(url: String): WebResourceResponse {").search(out)
out = out[:m.start()] + const + out[m.start():]
path.with_suffix(path.suffix + ".bak2").write_text(src, encoding="utf-8")
path.write_text(out, encoding="utf-8")
print("Patched", path)
