package com.swift.browser

import android.util.Log

/**
 * One line per navigation, popup and network-block decision. Read with: adb logcat -s SwiftShield
 * Logs decisions and truncated URLs only, never page content. Set enabled = false to silence it.
 */
object ShieldLog {
    @Volatile var enabled: Boolean = true

    fun log(kind: String, tab: Long, url: String, allowed: Boolean, reason: String) {
        if (!enabled) return
        Log.d(TAG, "$kind tab=$tab ${if (allowed) "ALLOW" else "BLOCK"} [$reason] ${url.take(200)}")
    }

    private const val TAG = "SwiftShield"
}
