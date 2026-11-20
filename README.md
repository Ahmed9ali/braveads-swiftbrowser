# Swift Browser: native ad blocking (adblock-rust + Brave lists) — drop-in files

Unzip into the ROOT of your repo (keeps the same folder layout), then:

1. `python3 tools/apply_main_activity_patch.py`  — 4 small edits to MainActivity.kt (backup: .bak)
2. Commit and push. `.github/workflows/build.yml` now builds `libswift_adblock.so` (Rust) before Gradle.

What's inside
- `app/src/main/java/com/swift/browser/TrackerBlocker.kt`  — YOUR file, complete, with the native engine added
  behind the same safety guards (speed tests, payment/checkout/sign-in pages, captcha hosts, YouTube).
- `app/src/main/java/com/swift/browser/adblock/*.kt`        — engine bridge, list manager, cosmetic + scriptlet bridge
- `app/src/main/assets/adblock/`                            — cosmetic.js (Brave's cosmetic filter scripts),
                                                              resources.json (225 uBO + Brave scriptlets/redirects),
                                                              list_catalog.json (Brave's list catalog)
- `rust/swift_adblock/`                                     — the JNI library (adblock 0.13, same engine as Brave)
- `.github/workflows/build.yml`                             — your workflow + Rust/NDK steps
- `js/`, `tools/`                                           — sources to regenerate cosmetic.js / resources.json

Behaviour
- If the .so is missing or fails to load, the app silently keeps your existing shields.
- Your Kotlin FilterEngine/FilterListManager still run until the native engine is ready; after that the native
  engine does network + cosmetic + scriptlets. Once you are happy, delete the `FilterListManager(...)` line in
  MainActivity.kt to free its memory.
- Shortener pages: the uBlock "link shorteners" list (timer boosters, focus spoofers, popup blockers) now runs for
  real, and a page that gets such rules calls `navGuard.markFlow(tabId)` so your guard lets the multi-step flow through.
- If you ever turn on `isMinifyEnabled` for release, add to proguard-rules.pro:
  `-keep class com.swift.browser.adblock.AdBlockNative { *; }`
  `-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }`
