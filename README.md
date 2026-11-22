# Chain fix: ads blocked before tap rules, shortlink steps stay in one tab, phone-side shield log

1. Copy these two files over yours (they include the flow patch):
   - app/src/main/java/com/swift/browser/NavigationGuard.kt
   - app/src/main/java/com/swift/browser/ShieldLog.kt  (new)
2. From the repo root run:  python3 tools/apply_chain_patch.py
   It adds the "Share shield log" row to Settings -> Privacy and security, and keeps allowed
   shortlink steps in the same tab. It prints "Already applied" if run twice.
3. Commit, let GitHub build, install the APK on the phone.

Reading the log on the phone:
Reproduce the chain (link.vipshort.in -> ... -> devuploads.com), then Settings -> Privacy and security ->
"Share shield log", and send it to yourself (Gmail, Notes). Each line shows ALLOW/BLOCK and the reason.
Look for: "ad destination", "ad popup", "popup from a link on a shortlink page", "shortlink button opened a window".

What changed:
- Ad hosts are refused BEFORE any tap rule (before, a tap on an ad let it through).
- Popups: ad check first; on shortlink pages only a labelled button may open a window; other
  pop-ups to unknown sites follow the old rules.
- Allowed popups on shortlink pages load in the same tab instead of a new tab.
- New: NavigationGuard.isFlow(tabId).
