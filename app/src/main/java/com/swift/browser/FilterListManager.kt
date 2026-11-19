package com.swift.browser

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

/**
 * Brave Shields filter lists, kept on disk and compiled into a [FilterEngine].
 *
 * The list set is the same one Brave enables by default: the Brave Default Adblock
 * Filters (uBlock Origin + EasyList + URLhaus + Brave's own lists), Brave Default
 * Privacy Filters (EasyPrivacy + uBO Privacy), Brave First Party Adblock Filters,
 * the Cookie Notice blocker and the Mobile app promo blocker. The regional list
 * matching the device language is added from Brave's filter list catalog.
 *
 * A snapshot of every default list is bundled in assets/brave_filters so blocking
 * works on first launch and offline. The bundled snapshot is seeded into app data
 * once, then refreshed from the same URLs Brave uses. Regional lists are
 * downloaded on first use.
 */
class FilterListManager(private val context: Context, private val onReady: (FilterEngine) -> Unit) {
    private class ListDef(
        val id: String,
        val title: String,
        val url: String,
        val asset: String?,
        val group: String
    )

    private val defaults: List<ListDef> = loadBundledDefs()
    private val regional: List<ListDef> = loadRegionalDefs()
    private val lists: List<ListDef> = defaults + regional

    private val dir = File(context.filesDir, "filterlists").apply { mkdirs() }
    private val prefs = context.getSharedPreferences("filter_lists", Context.MODE_PRIVATE)
    @Volatile private var started = false

    fun start() {
        if (started) return
        started = true
        Thread({
            try {
                seedBundled()
                rebuild()
                val now = System.currentTimeMillis()
                val stale = lists.any {
                    !file(it).exists() || now - prefs.getLong("updated_" + it.id, 0L) > DAY_MS
                }
                if (stale && download()) rebuild()
            } catch (e: Throwable) {
                Log.w(TAG, "filter list setup failed", e)
            }
        }, "swift-filter-lists").apply { priority = Thread.MIN_PRIORITY }.start()
    }

    private fun file(l: ListDef) = File(dir, l.id + ".txt")

    private fun readAsset(name: String): String? = try {
        context.assets.open(name).bufferedReader().use { it.readText() }
    } catch (e: Exception) {
        Log.w(TAG, "missing asset $name", e)
        null
    }

    private fun loadBundledDefs(): List<ListDef> {
        val json = readAsset("brave_filter_lists.json") ?: return emptyList()
        return try {
            val arr = org.json.JSONArray(json)
            buildList {
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    add(
                        ListDef(
                            o.getString("id"),
                            o.optString("title"),
                            o.getString("url"),
                            o.optString("asset").takeIf { it.isNotEmpty() },
                            o.optString("group", "default")
                        )
                    )
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "bad brave_filter_lists.json", e)
            emptyList()
        }
    }

    /** Brave enables the regional list for the UI language; mirror that for the device language. */
    private fun loadRegionalDefs(): List<ListDef> {
        val json = readAsset("brave_filter_catalog.json") ?: return emptyList()
        val lang = Locale.getDefault().language.lowercase(Locale.ROOT)
        return try {
            val arr = org.json.JSONArray(json)
            buildList {
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    if (o.optBoolean("default_enabled", false)) continue
                    val platforms = o.optJSONArray("platforms")
                    if (platforms != null) {
                        var android = false
                        for (p in 0 until platforms.length()) {
                            if (platforms.optString(p).equals("ANDROID", true)) android = true
                        }
                        if (!android) continue
                    }
                    val langs = o.optJSONArray("langs") ?: continue
                    var matches = false
                    for (l in 0 until langs.length()) {
                        if (langs.optString(l).equals(lang, true)) matches = true
                    }
                    if (!matches) continue
                    val sources = o.optJSONArray("sources") ?: continue
                    val uuid = o.optString("uuid", "regional-$i")
                    for (s in 0 until sources.length()) {
                        val src = sources.getJSONObject(s)
                        val url = src.optString("url")
                        if (url.isEmpty()) continue
                        add(
                            ListDef(
                                "regional-$uuid-$s",
                                src.optString("title", o.optString("title")),
                                url,
                                null,
                                "regional"
                            )
                        )
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "bad brave_filter_catalog.json", e)
            emptyList()
        }
    }

    /**
     * Copy the bundled Brave snapshot into app data once per bundle version. Downloaded
     * updates are kept, so an app update only replaces lists still using the old snapshot.
     */
    private fun seedBundled() {
        val version = prefs.getInt("bundle_version", 0)
        val freshInstall = version != BUNDLE_VERSION
        if (freshInstall) prefs.edit().putInt("bundle_version", BUNDLE_VERSION).apply()
        val now = System.currentTimeMillis()
        for (l in defaults) {
            val asset = l.asset ?: continue
            val out = file(l)
            if (out.exists() && !freshInstall) continue
            try {
                context.assets.open("brave_filters/$asset").use { i ->
                    val tmp = File(dir, l.id + ".tmp")
                    tmp.outputStream().use { o -> i.copyTo(o) }
                    if (tmp.length() > 0) {
                        if (out.exists()) out.delete()
                        if (!tmp.renameTo(out)) {
                            tmp.copyTo(out, overwrite = true)
                            tmp.delete()
                        }
                        prefs.edit().putLong("updated_" + l.id, now).apply()
                    } else tmp.delete()
                }
            } catch (e: Exception) {
                Log.w(TAG, "could not seed ${l.id}", e)
            }
        }
    }

    private fun rebuild() {
        val files = lists.mapNotNull { l -> file(l).takeIf { it.exists() && it.length() > 0 }?.let { l to it } }
        val t0 = System.currentTimeMillis()
        val b = FilterEngine.Builder()
        for ((_, f) in files) {
            f.bufferedReader().use { r -> b.addLines(r.lineSequence()) }
        }
        val e = b.build()
        Log.d(
            TAG,
            "Brave lists ready: ${files.size}/${lists.size} lists, " +
                "${e.networkRuleCount} network, ${e.cosmeticRuleCount} cosmetic rules " +
                "in ${System.currentTimeMillis() - t0} ms"
        )
        onReady(e)
    }

    /** Refresh stale lists. Returns true if at least one list changed. */
    private fun download(): Boolean {
        var changed = false
        var anyOk = false
        val now = System.currentTimeMillis()
        for (l in lists) {
            val out = file(l)
            val last = prefs.getLong("updated_" + l.id, 0L)
            if (out.exists() && now - last < DAY_MS) continue
            try {
                val c = URL(l.url).openConnection() as HttpURLConnection
                c.connectTimeout = 15000
                c.readTimeout = 30000
                val tag = prefs.getString("etag_" + l.id, null)
                if (tag != null && out.exists()) c.setRequestProperty("If-None-Match", tag)
                when (c.responseCode) {
                    200 -> {
                        val tmp = File(dir, l.id + ".tmp")
                        c.inputStream.use { i -> tmp.outputStream().use { o -> i.copyTo(o) } }
                        if (tmp.length() > 0 && tmp.renameTo(out).also {
                                if (!it) {
                                    out.delete()
                                    tmp.renameTo(out)
                                }
                            }
                        ) {
                            prefs.edit()
                                .putString("etag_" + l.id, c.getHeaderField("ETag"))
                                .putLong("updated_" + l.id, now)
                                .apply()
                            changed = true
                        } else tmp.delete()
                        anyOk = true
                    }
                    304 -> {
                        prefs.edit().putLong("updated_" + l.id, now).apply()
                        anyOk = true
                    }
                    else -> Log.w(TAG, "${l.id}: HTTP ${c.responseCode}")
                }
                c.disconnect()
            } catch (e: Exception) {
                Log.w(TAG, "${l.id} download failed: ${e.message}")
            }
        }
        if (anyOk) prefs.edit().putLong("last_update", now).apply()
        return changed
    }

    companion object {
        private const val TAG = "SwiftFilters"
        private const val DAY_MS = 24L * 60 * 60 * 1000
        private const val BUNDLE_VERSION = 1
    }
}
