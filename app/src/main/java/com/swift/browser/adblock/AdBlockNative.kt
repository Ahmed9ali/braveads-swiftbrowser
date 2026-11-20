package com.swift.browser.adblock

/** JNI bridge to libswift_adblock.so (Rust, built on Brave's adblock-rust engine). */
internal object AdBlockNative {
    /** False when libswift_adblock.so is missing (e.g. the CI step failed): callers then keep the built-in shields. */
    @JvmField
    val available: Boolean = try {
        System.loadLibrary("swift_adblock")
        true
    } catch (t: Throwable) {
        android.util.Log.e("SwiftAdBlock", "native engine not available", t)
        false
    }

    /** permissions[i] = catalog permission_mask of lists[i] (Brave default lists: 1 = may use trusted scriptlets). */
    @JvmStatic external fun nativeLoadLists(lists: Array<String>, permissions: IntArray): Boolean
    @JvmStatic external fun nativeLoadResources(json: String): Boolean

    /** Returns "" (allow), "B" (block), "R<data: url>" (serve redirect resource), "U<url>" (rewritten url). */
    @JvmStatic external fun nativeCheck(
        url: String,
        sourceUrl: String,
        requestType: String,
        method: String
    ): String

    /**
     * JSON: {"hide_selectors":[],"exceptions":[],"scriptlet":"","generichide":false,
     *        "procedural_actions":[],"vetted_search_engine":false}
     */
    @JvmStatic external fun nativeCosmetic(url: String): String

    /** Same registrable domain? (Brave: SameDomainOrHost with private registries) */
    @JvmStatic external fun nativeIsFirstParty(pageUrl: String, otherUrl: String): Boolean

    /** JSON array of CSS selectors for generic rules that match these classes/ids. */
    @JvmStatic external fun nativeHiddenClassId(
        classes: Array<String>,
        ids: Array<String>,
        exceptions: Array<String>
    ): String

    @JvmStatic external fun nativeSerialize(): ByteArray
    @JvmStatic external fun nativeDeserialize(data: ByteArray): Boolean
}
