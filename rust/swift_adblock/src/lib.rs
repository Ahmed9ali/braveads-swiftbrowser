//! JNI wrapper around Brave's `adblock-rust` engine for Android WebView browsers.
//!
//! Kotlin class: com.swift.browser.adblock.AdBlockNative
//! Rename the package in the `Java_...` function names if you use a different one.

use std::collections::HashSet;
use std::sync::RwLock;

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::resources::{PermissionMask, Resource};
use adblock::Engine;
use jni::objects::{JByteArray, JClass, JIntArray, JObjectArray, JString};
use jni::sys::{jboolean, jbyteArray, jstring, JNI_FALSE, JNI_TRUE};
use jni::JNIEnv;

static ENGINE: RwLock<Option<Engine>> = RwLock::new(None);

// ------------------------------------------------------------------------
// Core logic (plain Rust, unit-testable without a JVM)
// ------------------------------------------------------------------------

/// Result encoding returned to Kotlin:
///   ""        -> allow
///   "B"       -> block (empty response)
///   "R<data>" -> block and serve this data: URL instead (neutered resource)
///   "U<url>"  -> allow, but load this rewritten URL (removeparam)
pub fn check_request(url: &str, source_url: &str, request_type: &str, method: &str) -> String {
    let guard = ENGINE.read().unwrap();
    let Some(engine) = guard.as_ref() else {
        return String::new();
    };
    let Ok(request) = Request::new(url, source_url, request_type, method) else {
        return String::new();
    };
    let result = engine.check_network_request(&request);

    if result.should_block() {
        if let Some(redirect) = result.redirect {
            return format!("R{redirect}");
        }
        return "B".to_string();
    }
    if let Some(new_url) = result.rewritten_url {
        if matches!(method.to_ascii_uppercase().as_str(), "GET" | "HEAD" | "OPTIONS") {
            return format!("U{new_url}");
        }
    }
    String::new()
}

/// `permissions[i]` is the catalog `permission_mask` of `lists[i]` (Brave default lists use 1,
/// which lets them inject "trusted" scriptlets). Missing entries mean 0 (untrusted).
pub fn load_lists(lists: &[String], permissions: &[i32]) -> bool {
    let mut set = FilterSet::new(false);
    for (i, l) in lists.iter().enumerate() {
        let bits = permissions.get(i).copied().unwrap_or(0).clamp(0, 255) as u8;
        let opts = ParseOptions {
            permissions: PermissionMask::from_bits(bits),
            ..ParseOptions::default()
        };
        set.add_filter_list(l.clone(), opts);
    }
    let engine = Engine::new_with_filter_set(set);
    *ENGINE.write().unwrap() = Some(engine);
    true
}

pub fn load_resources(json: &str) -> Result<usize, String> {
    let resources: Vec<Resource> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let n = resources.len();
    let mut guard = ENGINE.write().unwrap();
    match guard.as_mut() {
        Some(engine) => {
            engine.use_resources(resources);
            Ok(n)
        }
        None => Err("engine not loaded; call loadLists first".into()),
    }
}

/// Search engines Brave treats as "vetted": non-aggressive cosmetic hiding is skipped there
/// (list taken from cosmetic_filters_js_handler.cc, kVettedSearchEngines).
const VETTED_SEARCH_ENGINES: [&str; 8] = [
    "duckduckgo", "qwant", "bing", "startpage", "google", "yandex", "ecosia", "brave",
];

pub fn is_vetted_search_engine(url: &str) -> bool {
    adblock::url_parser::parse_url(url)
        .map(|u| {
            let domain = u.domain().to_string();
            let label = domain.split('.').next().unwrap_or("").to_string();
            domain.contains('.') && VETTED_SEARCH_ENGINES.contains(&label.as_str())
        })
        .unwrap_or(false)
}

/// True when `url` and `base` share a registrable domain (Brave: SameDomainOrHost).
pub fn is_first_party(url: &str, base: &str) -> bool {
    match Request::new(url, base, "other", "get") {
        Ok(r) => !r.is_third_party,
        Err(_) => false,
    }
}

/// Port of GetScriptletGlobalsScript() from scriptlet_constants.cc (de-amp off, debug off).
const SCRIPTLET_GLOBALS: &str = r#"
  const scriptletGlobals = (() => {
    const forwardedMapMethods = ["has", "get", "set"];
    const handler = {
      get(target, prop) {
        if (forwardedMapMethods.includes(prop)) {
          return Map.prototype[prop].bind(target)
        }
        return target.get(prop);
      },
      set(target, prop, value) {
        if (!forwardedMapMethods.includes(prop)) {
          target.set(prop, value);
        }
      }
    };
    return new Proxy(new Map(), handler);
  })();
  let deAmpEnabled = false;
"#;

/// Same text Brave builds in kScriptletInitScript: `(function() {\n<globals>\n<scriptlets>})()`.
pub fn scriptlet_text(injected_script: &str) -> String {
    if injected_script.is_empty() {
        return String::new();
    }
    format!("(function() {{\n{SCRIPTLET_GLOBALS}\n{injected_script}}})()")
}

/// JSON consumed by the JS port of cosmetic_filters_js_handler.cc:
/// {"hide_selectors":[],"exceptions":[],"scriptlet":"","generichide":bool,
///  "procedural_actions":["<json>",...],"vetted_search_engine":bool}
pub fn cosmetic_resources(url: &str) -> String {
    let guard = ENGINE.read().unwrap();
    let Some(engine) = guard.as_ref() else {
        return "{}".into();
    };
    let r = engine.url_cosmetic_resources(url);
    let sorted = |set: &HashSet<String>| -> Vec<String> {
        let mut v: Vec<String> = set.iter().cloned().collect();
        v.sort();
        v
    };
    serde_json::json!({
        "hide_selectors": sorted(&r.hide_selectors),
        "exceptions": sorted(&r.exceptions),
        "scriptlet": scriptlet_text(&r.injected_script),
        "generichide": r.generichide,
        "procedural_actions": sorted(&r.procedural_actions),
        "vetted_search_engine": is_vetted_search_engine(url),
    })
    .to_string()
}

pub fn hidden_class_id(classes: &[String], ids: &[String], exceptions: &[String]) -> String {
    let guard = ENGINE.read().unwrap();
    let Some(engine) = guard.as_ref() else {
        return "[]".into();
    };
    let exc: HashSet<String> = exceptions.iter().cloned().collect();
    let sel = engine.hidden_class_id_selectors(classes, ids, &exc);
    serde_json::to_string(&sel).unwrap_or_else(|_| "[]".into())
}

// ------------------------------------------------------------------------
// JNI glue
// ------------------------------------------------------------------------

fn jstr(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(|s| s.into()).unwrap_or_default()
}

fn jstr_array(env: &mut JNIEnv, arr: &JObjectArray) -> Vec<String> {
    let len = env.get_array_length(arr).unwrap_or(0);
    let mut out = Vec::with_capacity(len as usize);
    for i in 0..len {
        if let Ok(o) = env.get_object_array_element(arr, i) {
            let s = JString::from(o);
            out.push(jstr(env, &s));
        }
    }
    out
}

fn new_jstring(env: &mut JNIEnv, s: &str) -> jstring {
    env.new_string(s).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

/// fun nativeLoadLists(lists: Array<String>, permissions: IntArray): Boolean
#[no_mangle]
pub extern "system" fn Java_com_swift_browser_adblock_AdBlockNative_nativeLoadLists(
    mut env: JNIEnv,
    _c: JClass,
    lists: JObjectArray,
    permissions: JIntArray,
) -> jboolean {
    let lists = jstr_array(&mut env, &lists);
    let len = env.get_array_length(&permissions).unwrap_or(0) as usize;
    let mut perms = vec![0i32; len];
    let _ = env.get_int_array_region(&permissions, 0, &mut perms);
    let ok = std::panic::catch_unwind(|| load_lists(&lists, &perms)).unwrap_or(false);
    if ok { JNI_TRUE } else { JNI_FALSE }
}

/// fun nativeLoadResources(json: String): Boolean
#[no_mangle]
pub extern "system" fn Java_com_swift_browser_adblock_AdBlockNative_nativeLoadResources(
    mut env: JNIEnv,
    _c: JClass,
    json: JString,
) -> jboolean {
    let json = jstr(&mut env, &json);
    match load_resources(&json) {
        Ok(_) => JNI_TRUE,
        Err(_) => JNI_FALSE,
    }
}

/// fun nativeCheck(url: String, sourceUrl: String, requestType: String, method: String): String
#[no_mangle]
pub extern "system" fn Java_com_swift_browser_adblock_AdBlockNative_nativeCheck(
    mut env: JNIEnv,
    _c: JClass,
    url: JString,
    source_url: JString,
    request_type: JString,
    method: JString,
) -> jstring {
    let (u, s, t, m) = (
        jstr(&mut env, &url),
        jstr(&mut env, &source_url),
        jstr(&mut env, &request_type),
        jstr(&mut env, &method),
    );
    let out = check_request(&u, &s, &t, &m);
    new_jstring(&mut env, &out)
}

/// fun nativeCosmetic(url: String): String  (JSON)
#[no_mangle]
pub extern "system" fn Java_com_swift_browser_adblock_AdBlockNative_nativeCosmetic(
    mut env: JNIEnv,
    _c: JClass,
    url: JString,
) -> jstring {
    let u = jstr(&mut env, &url);
    let out = cosmetic_resources(&u);
    new_jstring(&mut env, &out)
}

/// fun nativeHiddenClassId(classes: Array<String>, ids: Array<String>, exceptions: Array<String>): String (JSON array)
#[no_mangle]
pub extern "system" fn Java_com_swift_browser_adblock_AdBlockNative_nativeHiddenClassId(
    mut env: JNIEnv,
    _c: JClass,
    classes: JObjectArray,
    ids: JObjectArray,
    exceptions: JObjectArray,
) -> jstring {
    let c = jstr_array(&mut env, &classes);
    let i = jstr_array(&mut env, &ids);
    let e = jstr_array(&mut env, &exceptions);
    let out = hidden_class_id(&c, &i, &e);
    new_jstring(&mut env, &out)
}

/// fun nativeIsFirstParty(pageUrl: String, otherUrl: String): Boolean
#[no_mangle]
pub extern "system" fn Java_com_swift_browser_adblock_AdBlockNative_nativeIsFirstParty(
    mut env: JNIEnv,
    _c: JClass,
    page_url: JString,
    other_url: JString,
) -> jboolean {
    let (a, b) = (jstr(&mut env, &page_url), jstr(&mut env, &other_url));
    if is_first_party(&a, &b) { JNI_TRUE } else { JNI_FALSE }
}

/// fun nativeSerialize(): ByteArray  (engine cache for fast next startup)
#[no_mangle]
pub extern "system" fn Java_com_swift_browser_adblock_AdBlockNative_nativeSerialize(
    env: JNIEnv,
    _c: JClass,
) -> jbyteArray {
    let bytes = ENGINE.read().unwrap().as_ref().map(|e| e.serialize()).unwrap_or_default();
    env.byte_array_from_slice(&bytes)
        .map(|a| a.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

/// fun nativeDeserialize(data: ByteArray): Boolean
#[no_mangle]
pub extern "system" fn Java_com_swift_browser_adblock_AdBlockNative_nativeDeserialize(
    env: JNIEnv,
    _c: JClass,
    data: JByteArray,
) -> jboolean {
    let Ok(bytes) = env.convert_byte_array(&data) else {
        return JNI_FALSE;
    };
    let mut engine = Engine::default();
    if engine.deserialize(&bytes).is_err() {
        return JNI_FALSE;
    }
    *ENGINE.write().unwrap() = Some(engine);
    JNI_TRUE
}

// ------------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // The engine is a process-wide global, so tests must not run concurrently.
    static LOCK: Mutex<()> = Mutex::new(());

    const LIST: &str = "\
||ads.example.com^
||tracker.example.net^$third-party
||cdn.example.org/ad.js$script,redirect=noopjs
@@||ads.example.com/allowed^
example.com##.banner-ad
##.generic-ad
";

    #[test]
    fn blocks_and_allows() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load_lists(&[LIST.to_string()], &[]);
        assert_eq!(check_request("https://ads.example.com/x.js", "https://site.com/", "script", "GET"), "B");
        assert_eq!(check_request("https://ads.example.com/allowed/x.js", "https://site.com/", "script", "GET"), "");
        assert_eq!(check_request("https://site.com/app.js", "https://site.com/", "script", "GET"), "");
        // third-party only rule
        assert_eq!(check_request("https://tracker.example.net/p", "https://site.com/", "image", "GET"), "B");
        assert_eq!(check_request("https://tracker.example.net/p", "https://example.net/", "image", "GET"), "");
    }

    #[test]
    fn cosmetic() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load_lists(&[LIST.to_string()], &[]);
        let j: serde_json::Value = serde_json::from_str(&cosmetic_resources("https://example.com/page")).unwrap();
        assert!(j["hide_selectors"].as_array().unwrap().iter().any(|s| s == ".banner-ad"));
        let g = hidden_class_id(&["generic-ad".into()], &[], &[]);
        assert!(g.contains(".generic-ad"), "{g}");
    }

    #[test]
    fn first_party() {
        assert!(is_first_party("https://www.example.com/a", "https://cdn.example.com/x.png"));
        assert!(is_first_party("https://a.example.co.uk/", "https://b.example.co.uk/"));
        assert!(!is_first_party("https://www.example.com/", "https://ads.other.net/x.png"));
        assert!(!is_first_party("https://example.co.uk/", "https://other.co.uk/"));
    }

    #[test]
    fn helpers() {
        assert!(is_vetted_search_engine("https://www.google.co.uk/search?q=x"));
        assert!(is_vetted_search_engine("https://duckduckgo.com/?q=x"));
        assert!(!is_vetted_search_engine("https://example.com/"));
        assert!(!is_vetted_search_engine("https://notgoogle.com/"));
        assert!(is_first_party("https://static.site.com/a.png", "https://www.site.com/"));
        assert!(!is_first_party("https://ads.other.net/a.png", "https://www.site.com/"));
    }

    #[test]
    fn scriptlet_wrapping() {
        assert_eq!(scriptlet_text(""), "");
        let t = scriptlet_text("window.__x = 1;");
        assert!(t.starts_with("(function() {\n"));
        assert!(t.contains("scriptletGlobals"));
        assert!(t.ends_with("window.__x = 1;})()"));
    }

    #[test]
    fn serialize_roundtrip() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load_lists(&[LIST.to_string()], &[]);
        let bytes = ENGINE.read().unwrap().as_ref().unwrap().serialize();
        let mut e = Engine::default();
        e.deserialize(&bytes).unwrap();
        *ENGINE.write().unwrap() = Some(e);
        assert_eq!(check_request("https://ads.example.com/x.js", "https://site.com/", "script", "GET"), "B");
    }

    /// Run manually: LISTS_DIR=/path/to/lists cargo test --release -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_lists() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::var("LISTS_DIR").expect("set LISTS_DIR");
        let mut lists = vec![];
        for entry in std::fs::read_dir(&dir).unwrap() {
            let p = entry.unwrap().path();
            if p.extension().map(|e| e == "txt").unwrap_or(false) {
                let t = std::fs::read_to_string(&p).unwrap_or_default();
                if t.len() > 100 {
                    lists.push(t);
                }
            }
        }
        let t = std::time::Instant::now();
        load_lists(&lists, &vec![1; lists.len()]);
        println!("engine built from {} lists in {:?}", lists.len(), t.elapsed());
        let res = std::fs::read_to_string(format!("{dir}/resources.json")).unwrap();
        println!("resources loaded: {:?}", load_resources(&res));
        let cases = [
            ("https://securepubads.g.doubleclick.net/tag/js/gpt.js", "https://www.example.com/", "script"),
            ("https://www.google-analytics.com/analytics.js", "https://www.example.com/", "script"),
            ("https://www.googletagmanager.com/gtag/js?id=G-1", "https://www.example.com/", "script"),
            ("https://connect.facebook.net/en_US/fbevents.js", "https://www.example.com/", "script"),
            ("https://www.example.com/static/app.js", "https://www.example.com/", "script"),
            ("https://cdn.jsdelivr.net/npm/vue/dist/vue.js", "https://www.example.com/", "script"),
        ];
        for (u, s, ty) in cases {
            let r = check_request(u, s, ty, "GET");
            let shown: String = r.chars().take(60).collect();
            println!("{u} -> {shown:?}");
        }
        let c = cosmetic_resources("https://www.youtube.com/watch?v=x");
        println!("youtube cosmetic json bytes: {}", c.len());
        let t = std::time::Instant::now();
        for _ in 0..2000 {
            check_request("https://securepubads.g.doubleclick.net/tag/js/gpt.js", "https://www.example.com/", "script", "GET");
        }
        println!("2000 checks in {:?}", t.elapsed());
        let ser = ENGINE.read().unwrap().as_ref().unwrap().serialize();
        println!("serialized engine bytes: {}", ser.len());
    }

    #[test]
    #[ignore]
    fn shortlink_scriptlets() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::var("LISTS_DIR").expect("set LISTS_DIR");
        let mut lists = vec![];
        for entry in std::fs::read_dir(&dir).unwrap() {
            let p = entry.unwrap().path();
            if p.extension().map(|e| e == "txt").unwrap_or(false) {
                lists.push(std::fs::read_to_string(&p).unwrap_or_default());
            }
        }
        load_lists(&lists, &vec![1; lists.len()]);
        let res = std::fs::read_to_string(format!("{dir}/resources.json")).unwrap();
        println!("resources: {:?}", load_resources(&res));
        for u in ["https://xpshort.com/abc", "https://gplinks.co/EWu8", "https://tech5s.co/x", "https://carrnissan.com/p"] {
            let j: serde_json::Value = serde_json::from_str(&cosmetic_resources(u)).unwrap();
            let sc = j["scriptlet"].as_str().unwrap_or("");
            println!("{u}: scriptlet_bytes={} generichide={} hide={}", sc.len(), j["generichide"], j["hide_selectors"].as_array().map(|a| a.len()).unwrap_or(0));
            let tail: String = sc.chars().rev().take(260).collect::<String>().chars().rev().collect();
            println!("   tail: {}", tail.replace('\n', " "));
        }
    }
}
