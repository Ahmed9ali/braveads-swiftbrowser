package com.swift.browser.adblock

import org.json.JSONArray
import org.json.JSONObject

data class ListSource(val url: String, val title: String, val permissionMask: Int = 0)

/**
 * One entry of Brave's filter-list catalog (brave/adblock-resources, filter_lists/list_catalog.json).
 * Mirrors brave_shields::FilterListCatalogEntry. An entry is a *group* of source lists that Brave
 * merges and ships as one component; here every source is downloaded directly.
 */
data class CatalogEntry(
    val uuid: String,
    val title: String,
    val langs: List<String>,
    val hidden: Boolean,
    val defaultEnabled: Boolean,
    val firstPartyProtections: Boolean,
    val platforms: List<String>,
    val permissionMask: Int,
    val sources: List<ListSource>
) {
    /** Same rule as FilterListCatalogEntry::SupportsCurrentPlatform(): empty = all platforms. */
    fun supportsAndroid(): Boolean = platforms.isEmpty() || platforms.any { it.equals("ANDROID", true) }
}

object FilterListCatalog {
    fun parse(json: String): List<CatalogEntry> {
        val arr = JSONArray(json)
        val out = ArrayList<CatalogEntry>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val uuid = o.optString("uuid")
            if (uuid.isEmpty()) continue
            out += CatalogEntry(
                uuid = uuid,
                title = o.optString("title", uuid),
                langs = strings(o.optJSONArray("langs")),
                hidden = o.optBoolean("hidden", false),
                defaultEnabled = o.optBoolean("default_enabled", false),
                firstPartyProtections = o.optBoolean("first_party_protections", false),
                platforms = strings(o.optJSONArray("platforms")),
                permissionMask = o.optInt("permission_mask", 0),
                sources = sources(o.optJSONArray("sources"), o.optInt("permission_mask", 0))
            )
        }
        return out
    }

    private fun strings(a: JSONArray?): List<String> =
        if (a == null) emptyList() else List(a.length()) { a.optString(it) }

    private fun sources(a: JSONArray?, permissionMask: Int): List<ListSource> {
        if (a == null) return emptyList()
        val out = ArrayList<ListSource>()
        for (i in 0 until a.length()) {
            val s: JSONObject = a.optJSONObject(i) ?: continue
            val url = s.optString("url")
            if (url.startsWith("https://") || url.startsWith("http://")) {
                out += ListSource(url, s.optString("title", url), permissionMask)
            }
        }
        return out
    }
}
