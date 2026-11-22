package com.swift.browser

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import android.widget.Toast

/**
 * Links that are not web pages: UPI payment apps, intent:// app hand-offs, market://, tel:, mailto:.
 * Returns true when the WebView must NOT load the URL itself. Web URLs return false (WebView loads them).
 * Before this, every such link was cancelled silently, so payment and app buttons did nothing.
 */
fun handleExternalScheme(context: Context, view: WebView?, uri: Uri): Boolean {
    val scheme = uri.scheme?.lowercase() ?: return true
    when (scheme) {
        "http", "https" -> return false
        "about", "data", "blob", "javascript", "file" -> return true // unchanged: never loaded from here
    }
    val intent = try {
        if (scheme == "intent") Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
        else Intent(Intent.ACTION_VIEW, uri)
    } catch (e: Exception) {
        Toast.makeText(context, "This link can't be opened", Toast.LENGTH_SHORT).show()
        return true
    }
    if (scheme == "intent") {
        // intent:// links name the web page to use when no app is installed.
        val fallback = intent.getStringExtra("browser_fallback_url")
        if (fallback != null && (fallback.startsWith("https://") || fallback.startsWith("http://"))) {
            view?.loadUrl(fallback)
            return true
        }
    }
    intent.addCategory(Intent.CATEGORY_BROWSABLE)
    return try {
        context.startActivity(intent)
        true
    } catch (e: Exception) {
        Toast.makeText(context, "No app installed to open this link", Toast.LENGTH_SHORT).show()
        true
    }
}
