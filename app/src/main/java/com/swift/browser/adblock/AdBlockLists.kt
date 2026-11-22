package com.swift.browser.adblock

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Downloads, caches and loads filter lists into the native engine, using Brave's own list catalog.
 *
 * Which lists: every catalog entry that is `default_enabled` and valid for Android (Brave's default
 * ad, privacy, first-party, cookie-notice and mobile-promo lists, ~30 sources), plus
 *  - [extraListUuids] you opt into (e.g. "Annoying distractions blocker"), and
 *  - the regional list(s) matching the device language when [autoEnableRegional] is true.
 *
 * Start-up order (fast path first):
 *   1. engine.dat (serialized engine, only if the list selection is unchanged)  -> a few ms
 *   2. cached list files in filesDir                                            -> ~100 ms
 *   3. lists bundled in assets/adblock (*.txt files, optional, first run offline)
 * Then anything older than [UPDATE_INTERVAL_MS] is re-downloaded in the background.
 */
object AdBlockLists {
    private const val TAG = "SwiftAdBlock"
    private const val UPDATE_INTERVAL_MS = 24L * 60 * 60 * 1000

    var catalogUrl =
        "https://raw.githubusercontent.com/brave/adblock-resources/master/filter_lists/list_catalog.json"

    /**
     * Scriptlets + redirect resources used by the engine. The bundled assets/adblock/resources.json
     * already contains Brave's resources AND uBlock Origin's scriptlets/redirects (which the
     * shortener and anti-adblock rules need). Leave null unless you host your own full file;
     * Brave's raw dist/resources.json alone is NOT enough (it has no uBO scriptlets).
     */
    var resourcesUrl: String? = null

    /** Catalog UUIDs of optional lists to enable on top of Brave's defaults. Set before init(). */
    var extraListUuids: Set<String> = emptySet()

    /** Also enable catalog lists whose `langs` contains the device language. Set before init(). */
    var autoEnableRegional: Boolean = true

    @Volatile var ready: Boolean = false
        private set

    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var dir: File
    private lateinit var appContext: Context

    /** Call once from Application.onCreate(). Non-blocking. */
    fun init(context: Context, onReady: (() -> Unit)? = null) {
        if (!AdBlockNative.available) return
        appContext = context.applicationContext
        dir = File(appContext.filesDir, "adblock").apply { mkdirs() }
        // Older versions downloaded Brave's partial resources.json; it must not shadow the bundled one.
        if (resourcesUrl == null) File(dir, "resources.json").delete()
        executor.execute {
            try {
                ready = loadLocal()
                if (ready) onReady?.invoke()
                updateIfStale()
                if (!ready && loadLocal()) {
                    ready = true
                    onReady?.invoke()
                }
            } catch (t: Throwable) {
                Log.e(TAG, "init failed", t)
            }
        }
    }

    /** Force re-download now (call from a settings button). Runs in background. */
    fun updateNow() = executor.execute {
        try {
            updateIfStale(force = true)
        } catch (t: Throwable) {
            Log.e(TAG, "update failed", t)
        }
    }

    // ------------------------------------------------------------------ selection

    private val catalogFile get() = File(dir, "list_catalog.json")
    private val engineFile get() = File(dir, "engine.dat")
    private val engineSigFile get() = File(dir, "engine.sig")
    private val resourcesFile get() = File(dir, "resources.json")

    private fun loadCatalog(): List<CatalogEntry> {
        val text = when {
            catalogFile.exists() -> catalogFile.readText()
            else -> runCatching {
                appContext.assets.open("adblock/list_catalog.json").bufferedReader().use { it.readText() }
            }.getOrNull()
        } ?: return emptyList()
        return runCatching { FilterListCatalog.parse(text) }.getOrDefault(emptyList())
    }

    /** Deduplicated source URLs of every enabled catalog entry. */
    private fun selectedSources(): List<ListSource> {
        val lang = Locale.getDefault().language
        val extra = extraListUuids.map { it.lowercase() }.toSet()
        return loadCatalog()
            .filter { it.supportsAndroid() }
            .filter {
                it.defaultEnabled ||
                    it.uuid.lowercase() in extra ||
                    (autoEnableRegional && it.langs.any { l -> l.equals(lang, ignoreCase = true) })
            }
            .flatMap { it.sources }
            .distinctBy { it.url }
    }

    private fun fileFor(s: ListSource) = File(dir, "list-" + sha1(s.url).take(12) + ".txt")

    private fun signature(sources: List<ListSource>) = sha1(sources.map { it.url }.sorted().joinToString("\n"))

    private fun sha1(s: String) =
        MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    // ------------------------------------------------------------------ loading

    private fun loadLocal(): Boolean {
        val sources = selectedSources()
        var loaded = false

        val dat = engineFile
        if (dat.exists() && engineSigFile.exists() && engineSigFile.readText() == signature(sources)) {
            loaded = runCatching { AdBlockNative.nativeDeserialize(dat.readBytes()) }.getOrDefault(false)
            if (!loaded) dat.delete()
        }
        if (!loaded) {
            val (texts, perms) = readCachedLists(sources)
            if (texts.isEmpty()) return false
            loaded = AdBlockNative.nativeLoadLists(texts.toTypedArray(), perms.toIntArray())
            if (loaded) writeEngineCache(sources)
        }
        if (loaded) loadResources()
        return loaded
    }

    /** Cached list texts with their permission masks; falls back to lists bundled in assets. */
    private fun readCachedLists(sources: List<ListSource>): Pair<List<String>, List<Int>> {
        val texts = ArrayList<String>()
        val perms = ArrayList<Int>()
        for (s in sources) {
            val f = fileFor(s)
            if (f.exists()) { texts += f.readText(); perms += s.permissionMask }
        }
        if (texts.isEmpty()) {
            runCatching {
                appContext.assets.list("adblock").orEmpty().filter { it.endsWith(".txt") }.forEach {
                    texts += appContext.assets.open("adblock/$it").bufferedReader().use { r -> r.readText() }
                    perms += 1
                }
            }
        }
        return texts to perms
    }

    private fun loadResources() {
        val json = when {
            resourcesUrl != null && resourcesFile.exists() -> resourcesFile.readText()
            else -> runCatching {
                appContext.assets.open("adblock/resources.json").bufferedReader().use { it.readText() }
            }.getOrNull()
        } ?: return
        if (!AdBlockNative.nativeLoadResources(json)) Log.w(TAG, "resources.json rejected")
    }

    private fun writeEngineCache(sources: List<ListSource>) {
        val bytes = AdBlockNative.nativeSerialize()
        if (bytes.isEmpty()) return
        val tmp = File(dir, "engine.dat.tmp")
        tmp.writeBytes(bytes)
        if (tmp.renameTo(engineFile)) engineSigFile.writeText(signature(sources))
    }

    // ------------------------------------------------------------------ updating

    private fun stale(f: File) = !f.exists() || System.currentTimeMillis() - f.lastModified() > UPDATE_INTERVAL_MS

    private fun updateIfStale(force: Boolean = false) {
        // Catalog first: it decides which lists exist (Brave adds/retires lists over time).
        if (force || stale(catalogFile)) download(catalogUrl, catalogFile, minBytes = 1000)

        val sources = selectedSources()
        var changed = false
        for (s in sources) {
            val f = fileFor(s)
            if (force || stale(f)) changed = download(s.url, f, minBytes = 10) || changed
        }
        val resUrl = resourcesUrl
        val resChanged = resUrl != null && (force || stale(resourcesFile)) &&
            download(resUrl, resourcesFile, minBytes = 1000)

        val selectionChanged = !engineSigFile.exists() || engineSigFile.readText() != signature(sources)
        val haveAnyList = sources.any { fileFor(it).exists() }
        if (haveAnyList && (changed || selectionChanged || !ready)) {
            val (texts, perms) = readCachedLists(sources)
            if (AdBlockNative.nativeLoadLists(texts.toTypedArray(), perms.toIntArray())) {
                loadResources()
                writeEngineCache(sources)
                ready = true
                Log.i(TAG, "engine rebuilt from ${texts.size}/${sources.size} lists")
            }
        } else if (resChanged && ready) {
            loadResources()
        }
    }

    /** Returns true if the file content changed. */
    private fun download(url: String, target: File, minBytes: Int): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = TimeUnit.SECONDS.toMillis(15).toInt()
                readTimeout = TimeUnit.SECONDS.toMillis(60).toInt()
                if (target.exists()) ifModifiedSince = target.lastModified()
                setRequestProperty("User-Agent", "SwiftBrowser-AdBlock/1.0")
            }
            when (conn.responseCode) {
                HttpURLConnection.HTTP_NOT_MODIFIED -> {
                    target.setLastModified(System.currentTimeMillis()); false
                }
                HttpURLConnection.HTTP_OK -> {
                    val bytes = conn.inputStream.use { it.readBytes() }
                    // Reject error pages so a bad fetch never replaces a good list. (Some Brave lists
                    // are legitimately tiny, so the size floor is small.)
                    if (bytes.size < minBytes ||
                        String(bytes, 0, minOf(bytes.size, 200)).contains("<html", true)
                    ) {
                        Log.w(TAG, "rejected download from $url")
                        false
                    } else {
                        val tmp = File(target.parentFile, target.name + ".tmp")
                        tmp.writeBytes(bytes)
                        tmp.renameTo(target)
                    }
                }
                else -> false
            }
        } catch (t: Throwable) {
            Log.w(TAG, "download failed: $url (${t.message})")
            false
        } finally {
            conn?.disconnect()
        }
    }
}
