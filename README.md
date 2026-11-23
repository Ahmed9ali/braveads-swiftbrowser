# cf-fix: Cloudflare challenge loop, shortlink timer freeze, block score, richer shield log

Order matters: flow patch -> chain fix -> THIS.

1. Copy into app/src/main/java/com/swift/browser/ :
   - ChallengeSites.kt                (new)
   - ShieldLog.kt                     (replaces)
   - adblock/AdBlockLists.kt          (replaces)
2. From the repo root:  python3 tools/apply_cf_patch.py
   (writes nothing and says why if an earlier fix is missing or an anchor does not match)
3. Commit, build on GitHub, install.

What it changes
- Cloudflare: the "Just a moment..." page runs on the site's own address, so the old captcha-host exemption
  never covered it, and the page ran with our patched browser functions. Now: the app notices the challenge
  page, remembers the site, reloads once with NO page-side patches until cf_clearance exists. Network blocking
  stays on. Shields-down sites and speed tests also get no page patches any more.
- Shortlinks: a shortlink tab's JavaScript timers are no longer frozen (WebView.onPause) while another tab
  (an ad) is in front.
- Block score: the exact-host list (trackers.txt) is kept on top of the native engine again.
- Log: Settings -> Privacy and security -> Share shield log now starts with an engine status line and also records
  flow switches, Cloudflare probes and page console errors.

Test
1. Open https://moviesmod.cc/home. Within ~10 s it should pass the check. Then Share shield log: look for a "cf" line.
2. Run the vipshort chain. Share the log right after it stops.
3. Open your ad-block test page again and note the score.
