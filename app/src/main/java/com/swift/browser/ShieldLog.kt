package com.swift.browser

import android.content.Context
import android.content.Intent
import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Keeps the last decisions of this session in memory, so you can read them on the phone without adb.
 * Settings -> Privacy and security -> "Share shield log" sends them to any app (Notes, Gmail, WhatsApp).
 * Each line: time, kind (nav / popup / net), tab, ALLOW or BLOCK, the reason, and the URL (truncated).
 */
object ShieldLog {
    @Volatile var enabled: Boolean = true
    private const val MAX_LINES = 1000
    private const val TAG = "SwiftShield"
    private val lines = ArrayDeque<String>()
    private val clock = SimpleDateFormat("HH:mm:ss", Locale.US)

    @Synchronized fun log(kind: String, tab: Long, url: String, allowed: Boolean, reason: String) {
        if (!enabled) return
        val line = "${clock.format(Date())} $kind tab=$tab ${if (allowed) "ALLOW" else "BLOCK"} [$reason] ${url.take(200)}"
        lines.addLast(line)
        while (lines.size > MAX_LINES) lines.removeFirst()
        Log.d(TAG, line)
    }

    @Synchronized fun dump(): String = lines.joinToString("\n")

    fun share(context: Context) {
        val text = dump().ifBlank { "No shield decisions recorded in this session yet. Open a site, then try again." }
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Swift Browser shield log")
            putExtra(Intent.EXTRA_TEXT, text)
        }
        runCatching { context.startActivity(Intent.createChooser(send, "Share shield log")) }
    }
}
