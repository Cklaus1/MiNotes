//! Remote images (ARCH-findings B-6/U-16): the webview never loads an image from
//! the network. Notes show a placeholder until the user allows remote images
//! (Settings → Remote images, per notebook, or per page view); then the frontend
//! asks `fetch_remote_image` for the bytes and shows them as a `blob:` URL. The
//! CSP has no `https:` in `img-src`, so a missed path fails closed.
//!
//! Every request goes through the SSRF-safe client also used for link previews:
//! `SafeResolver` drops non-public DNS answers, IP-literal hosts are checked by
//! `check_outbound_url`, redirects are followed by hand and re-validated, proxies
//! are off. On top of that: https only, a size cap (checked against
//! Content-Length and while streaming), a timeout, an `image/*` content type, and
//! a body whose magic bytes really are an image.

use std::time::Duration;

use minotes_core::repo::attachments::Attachment;
use tauri::State;

use crate::{security, AppState};

/// Largest remote image accepted.
pub const MAX_REMOTE_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REDIRECTS: usize = 3;

/// The SSRF-safe client: public addresses only (checked at DNS-resolution time),
/// no automatic redirects, no proxies.
pub fn safe_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(CONNECT_TIMEOUT.min(timeout))
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(std::sync::Arc::new(security::SafeResolver))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())
}

fn same_origin(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// GET `url`, following up to `max_redirects` redirects, validating every hop.
/// `https_only` refuses plain http. `test_origin` (debug builds / tests only, see
/// [`test_origin`]) is the one origin exempt from the address checks.
pub async fn safe_get(
    client: &reqwest::Client,
    url: &str,
    max_redirects: usize,
    https_only: bool,
    test_origin: Option<&reqwest::Url>,
) -> Result<reqwest::Response, String> {
    let mut current = reqwest::Url::parse(url).map_err(|_| "Not a valid web address".to_string())?;
    let mut hops = 0;
    loop {
        let exempt = test_origin.is_some_and(|o| same_origin(o, &current));
        if !exempt {
            security::check_outbound_url(&current)?;
            if https_only && current.scheme() != "https" {
                return Err("Only https:// images are loaded".into());
            }
        }
        let resp = client.get(current.clone()).send().await.map_err(|e| describe(&e))?;
        if !resp.status().is_redirection() {
            return Ok(resp);
        }
        hops += 1;
        if hops > max_redirects {
            return Err("Too many redirects".into());
        }
        let loc = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or("Redirect without a Location")?;
        current = current.join(loc).map_err(|_| "Bad redirect".to_string())?;
    }
}

fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "The image server did not answer in time".into();
    }
    // The resolver's refusal is buried in the source chain.
    let mut src: Option<&dyn std::error::Error> = Some(e);
    while let Some(s) = src {
        if s.to_string().contains("non-public") {
            return "Destination address not allowed".into();
        }
        src = s.source();
    }
    if e.is_connect() {
        return "Couldn't connect to the image server".into();
    }
    "Couldn't load the image".into()
}

/// What an image body really is, by its magic bytes (None: not an image we show).
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    let b = bytes;
    if b.starts_with(b"\x89PNG\r\n\x1a\n") { return Some("image/png"); }
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) { return Some("image/jpeg"); }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") { return Some("image/gif"); }
    if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" { return Some("image/webp"); }
    if b.starts_with(b"BM") && b.len() > 14 { return Some("image/bmp"); }
    if b.starts_with(&[0, 0, 1, 0]) && b.len() > 6 { return Some("image/x-icon"); }
    if b.len() >= 12 && &b[4..8] == b"ftyp" && (&b[8..12] == b"avif" || &b[8..12] == b"avis") { return Some("image/avif"); }
    // SVG: text that opens an <svg> element (shown only through <img>, where
    // scripts and external loads don't run).
    let head = String::from_utf8_lossy(&b[..b.len().min(1024)]).to_ascii_lowercase();
    let t = head.trim_start_matches('\u{feff}').trim_start();
    if (t.starts_with("<svg") || t.starts_with("<?xml") || t.starts_with("<!--") || t.starts_with("<!doctype svg")) && head.contains("<svg") {
        return Some("image/svg+xml");
    }
    None
}

/// Fetch a remote image: (bytes, sniffed mime). All checks are in here.
pub async fn fetch_image(url: &str, test_origin: Option<&reqwest::Url>, max_bytes: usize) -> Result<(Vec<u8>, &'static str), String> {
    let client = safe_client(TIMEOUT)?;
    let mut resp = safe_get(&client, url, MAX_REDIRECTS, true, test_origin).await?;
    if !resp.status().is_success() {
        return Err(format!("The image server answered {}", resp.status().as_u16()));
    }
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !ctype.starts_with("image/") {
        return Err(format!("Not an image ({})", if ctype.is_empty() { "no content type" } else { &ctype }));
    }
    if resp.content_length().is_some_and(|n| n > max_bytes as u64) {
        return Err(format!("Image is larger than {} MB", max_bytes / (1024 * 1024)));
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| describe(&e))? {
        if body.len() + chunk.len() > max_bytes {
            return Err(format!("Image is larger than {} MB", max_bytes / (1024 * 1024)));
        }
        body.extend_from_slice(&chunk);
    }
    let mime = sniff_image(&body).ok_or("Not an image (the content isn't a known image format)")?;
    Ok((body, mime))
}

/// Debug builds only: `MINOTES_TEST_IMAGE_ORIGIN=http://127.0.0.1:<port>` lets
/// the desktop journeys serve a test image from a local server. Exactly that one
/// origin (an IP literal; hostnames still go through `SafeResolver`) skips the
/// address and https checks; every other loopback/private address stays refused.
/// Compiled out of release builds.
pub fn test_origin() -> Option<reqwest::Url> {
    #[cfg(debug_assertions)]
    {
        let v = std::env::var("MINOTES_TEST_IMAGE_ORIGIN").ok()?;
        let u = reqwest::Url::parse(&v).ok()?;
        let host = u.host_str()?.trim_start_matches('[').trim_end_matches(']');
        if host.parse::<std::net::IpAddr>().is_ok() { return Some(u); }
        None
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

/// The bytes of a remote image (raw IPC response; the frontend sniffs the type).
#[tauri::command]
pub async fn fetch_remote_image(url: String) -> Result<tauri::ipc::Response, String> {
    let origin = test_origin();
    let (bytes, _) = fetch_image(&url, origin.as_ref(), MAX_REMOTE_IMAGE_BYTES).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// A file name for a downloaded image: the URL's last path segment, with an
/// extension that matches what the bytes are.
pub fn image_file_name(url: &str, mime: &str) -> String {
    let ext = match mime {
        "image/png" => "png", "image/jpeg" => "jpg", "image/gif" => "gif", "image/webp" => "webp",
        "image/bmp" => "bmp", "image/x-icon" => "ico", "image/avif" => "avif", "image/svg+xml" => "svg",
        _ => "img",
    };
    let seg = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.path_segments().and_then(|s| s.filter(|x| !x.is_empty()).last().map(|s| s.to_string())))
        .map(|s| minotes_core::repo::attachments::decode_name(&s))
        .unwrap_or_default();
    let stem = seg.rsplit_once('.').map(|(a, _)| a.to_string()).unwrap_or(seg);
    let stem: String = stem.chars().filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c)).take(80).collect();
    let stem = stem.trim().trim_start_matches('.');
    format!("{}.{ext}", if stem.is_empty() { "image" } else { stem })
}

/// "Save to notebook": fetch the image and keep it in the attachment store, so the
/// note can reference `attachment:<hash>/<name>` and work offline.
#[tauri::command]
pub async fn save_remote_image(state: State<'_, AppState>, url: String) -> Result<Attachment, String> {
    if state.session.lock().map_err(|e| e.to_string())?.held_by.is_some() {
        return Err("This notebook is open read-only in this window".into());
    }
    let origin = test_origin();
    let (bytes, mime) = fetch_image(&url, origin.as_ref(), MAX_REMOTE_IMAGE_BYTES).await?;
    let name = image_file_name(&url, mime);
    let db = state.db_guard()?;
    db.store_attachment_bytes(&name, Some(mime), &bytes).map(|s| s.attachment).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89";

    /// A one-shot-per-connection HTTP server on 127.0.0.1 answering every request
    /// with `respond(path)`. Returns its origin and a request counter.
    fn serve(respond: impl Fn(&str) -> Vec<u8> + Send + Sync + 'static) -> (reqwest::Url, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                h.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let _ = s.write_all(&respond(&path));
                let _ = s.flush();
            }
        });
        (reqwest::Url::parse(&format!("http://127.0.0.1:{port}")).unwrap(), hits)
    }

    fn http(ctype: &str, body: &[u8], length: bool) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nConnection: close\r\n").into_bytes();
        if length { out.extend_from_slice(format!("Content-Length: {}\r\n", body.len()).as_bytes()); }
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(body);
        out
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn private_and_non_https_destinations_are_refused_without_a_request() {
        let (origin, hits) = serve(|_| http("image/png", PNG, true));
        let port = origin.port().unwrap();
        for url in [
            format!("http://127.0.0.1:{port}/a.png"),
            format!("https://127.0.0.1:{port}/a.png"),
            format!("http://localhost:{port}/a.png"),
            format!("http://[::1]:{port}/a.png"),
            "https://10.0.0.1/a.png".into(),
            "https://192.168.1.1/a.png".into(),
            "https://169.254.169.254/latest/meta-data".into(),
            "http://example.com/a.png".into(),
            "file:///etc/passwd".into(),
            "not a url".into(),
        ] {
            // No test origin: nothing is exempt.
            let r = run(fetch_image(&url, None, MAX_REMOTE_IMAGE_BYTES));
            assert!(r.is_err(), "{url} must be refused");
        }
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(hits.load(Ordering::SeqCst), 0, "the local server must never be contacted");
    }

    #[test]
    fn hostnames_resolving_to_loopback_are_refused() {
        let r = run(fetch_image("https://localhost.:9/a.png", None, MAX_REMOTE_IMAGE_BYTES));
        assert!(r.is_err());
    }

    #[test]
    fn a_real_image_from_the_allowed_test_origin_loads() {
        let (origin, _) = serve(|_| http("image/png", PNG, true));
        let (bytes, mime) = run(fetch_image(origin.join("/pic.png").unwrap().as_str(), Some(&origin), MAX_REMOTE_IMAGE_BYTES)).unwrap();
        assert_eq!(bytes, PNG);
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn the_test_origin_exempts_only_itself() {
        let (origin, _) = serve(|_| http("image/png", PNG, true));
        let (other, other_hits) = serve(|_| http("image/png", PNG, true));
        let r = run(fetch_image(other.join("/x.png").unwrap().as_str(), Some(&origin), MAX_REMOTE_IMAGE_BYTES));
        assert!(r.is_err());
        // …and a redirect from the allowed origin to another loopback port is refused.
        let target = other.join("/x.png").unwrap().to_string();
        let (redir, _) = serve(move |_| format!("HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes());
        let r = run(fetch_image(redir.join("/r").unwrap().as_str(), Some(&redir), MAX_REMOTE_IMAGE_BYTES));
        assert_eq!(r.unwrap_err(), "Destination address not allowed");
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(other_hits.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn non_images_are_refused() {
        let (origin, _) = serve(|p| match p {
            "/page" => http("text/html", b"<html><title>x</title></html>", true),
            "/liar.png" => http("image/png", b"<html>not an image</html>", true),
            "/none" => http("", PNG, true),
            _ => http("image/svg+xml", br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#, true),
        });
        let get = |p: &str| run(fetch_image(origin.join(p).unwrap().as_str(), Some(&origin), MAX_REMOTE_IMAGE_BYTES));
        assert!(get("/page").unwrap_err().starts_with("Not an image"));
        assert!(get("/liar.png").unwrap_err().starts_with("Not an image"));
        assert!(get("/none").unwrap_err().starts_with("Not an image"));
        assert_eq!(get("/icon.svg").unwrap().1, "image/svg+xml");
    }

    #[test]
    fn oversized_images_are_refused() {
        let big: Vec<u8> = PNG.iter().copied().chain(std::iter::repeat(0u8).take(4096)).collect();
        let big2 = big.clone();
        let (origin, _) = serve(move |p| if p == "/stream" { http("image/png", &big2, false) } else { http("image/png", &big2, true) });
        let get = |p: &str| run(fetch_image(origin.join(p).unwrap().as_str(), Some(&origin), 1024));
        // Declared too big (Content-Length) and streamed too big (no length).
        assert!(get("/declared").unwrap_err().contains("larger than"));
        assert!(get("/stream").unwrap_err().contains("larger than"));
        // Under the cap it loads.
        let ok = run(fetch_image(origin.join("/declared").unwrap().as_str(), Some(&origin), big.len()));
        assert_eq!(ok.unwrap().0.len(), big.len());
    }

    #[test]
    fn sniffing() {
        assert_eq!(sniff_image(PNG), Some("image/png"));
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"<?xml version=\"1.0\"?><svg/>"), Some("image/svg+xml"));
        assert_eq!(sniff_image(b"<html><svg/></html>"), None);
        assert_eq!(sniff_image(b"hello"), None);
        assert_eq!(sniff_image(b""), None);
    }

    #[test]
    fn file_names() {
        assert_eq!(image_file_name("https://x.org/a/b/Photo%20One.jpeg?x=1", "image/jpeg"), "Photo One.jpg");
        assert_eq!(image_file_name("https://x.org/", "image/png"), "image.png");
        assert_eq!(image_file_name("https://x.org/..%2F..%2Fetc", "image/gif"), "image.gif");
        assert_eq!(image_file_name("https://x.org/pic.php", "image/webp"), "pic.webp");
    }
}
