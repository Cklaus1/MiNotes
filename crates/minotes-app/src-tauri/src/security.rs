//! Input validation helpers for Tauri commands that touch the filesystem or the
//! network on behalf of the (untrusted) webview. Every command reachable from the
//! frontend must assume its arguments may come from injected script (XSS in a note,
//! a malicious CSS snippet, a compromised plugin), so these helpers enforce the
//! narrowest contract the legitimate UI actually needs.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Component, Path, PathBuf};

// ── Filenames ──

/// Reduce a frontend-supplied export filename to a safe basename ending in `.png`.
/// Rejects anything that is not a plain single path component: empty names, `.`/`..`,
/// path separators, NUL, control characters, and absolute/drive-prefixed paths.
pub fn safe_png_filename(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
        || name.chars().any(|c| c.is_control())
    {
        return Err(format!("Invalid filename: {name:?}"));
    }
    // Must be exactly one normal component (defense in depth against platform quirks).
    let mut comps = Path::new(name).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => return Err(format!("Invalid filename: {name:?}")),
    }
    let stem = if name.to_ascii_lowercase().ends_with(".png") {
        &name[..name.len() - 4]
    } else {
        name
    };
    if stem.is_empty() || stem.chars().all(|c| c == '.') {
        return Err(format!("Invalid filename: {name:?}"));
    }
    Ok(format!("{stem}.png"))
}

// ── Graph names ──

/// Same rule `minotes_core::repo::graphs::create_graph` enforces: non-empty, no path
/// separators, no dots, no NUL. Applied to every command that turns a graph name into
/// a path under the data dir (switch/delete/startup), not just create.
pub fn validate_graph_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains('.')
        || name.contains('\0')
        || name.chars().any(|c| c.is_control())
    {
        return Err(format!(
            "Invalid graph name: '{name}'. Must be non-empty and contain no path separators or dots."
        ));
    }
    Ok(())
}

// ── Image file reads ──

pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

fn has_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Validate a path the frontend wants read as an image (drag-dropped file). The
/// extension is checked on the *canonical* path so a `photo.png` symlink pointing at
/// `~/.ssh/id_rsa` is refused. Returns the canonical path.
pub fn validate_image_path(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("Image path must be absolute".into());
    }
    if !has_image_extension(p) {
        return Err("Not an allowed image file type".into());
    }
    let canon = std::fs::canonicalize(p).map_err(|e| format!("Read failed: {e}"))?;
    if !has_image_extension(&canon) {
        return Err("Not an allowed image file type".into());
    }
    let meta = std::fs::metadata(&canon).map_err(|e| format!("Read failed: {e}"))?;
    if !meta.is_file() {
        return Err("Not a regular file".into());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!("Image too large (max {} MB)", MAX_IMAGE_BYTES / 1024 / 1024));
    }
    Ok(canon)
}

// ── PDF viewer ──

pub const MAX_PDF_BYTES: u64 = 200 * 1024 * 1024;

fn has_pdf_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

/// Validate a path the user asked the PDF viewer to open. Same rules as images:
/// absolute (a leading `~/` is expanded against `home`), `.pdf` extension checked
/// on the *canonical* path so a `x.pdf` symlink to a secret is refused, regular
/// file, size-capped. Returns the canonical path.
pub fn validate_pdf_path(path: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    let expanded = match (path.strip_prefix("~/"), home) {
        (Some(rest), Some(h)) => h.join(rest),
        _ => PathBuf::from(path),
    };
    if !expanded.is_absolute() {
        return Err("PDF path must be absolute".into());
    }
    if !has_pdf_extension(&expanded) {
        return Err("Not a PDF file".into());
    }
    let canon = std::fs::canonicalize(&expanded).map_err(|e| format!("Cannot open PDF: {e}"))?;
    if !has_pdf_extension(&canon) {
        return Err("Not a PDF file".into());
    }
    let meta = std::fs::metadata(&canon).map_err(|e| format!("Cannot open PDF: {e}"))?;
    if !meta.is_file() {
        return Err("Not a regular file".into());
    }
    if meta.len() > MAX_PDF_BYTES {
        return Err(format!("PDF too large (max {} MB)", MAX_PDF_BYTES / 1024 / 1024));
    }
    Ok(canon)
}

// ── Publish output directory ──

/// Canonicalize the deepest existing ancestor of `path`, then re-append the
/// not-yet-existing tail (which may contain only normal components).
fn canonicalize_creatable(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if existing.exists() {
            break;
        }
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => return Err("Output directory has no existing ancestor".into()),
        }
    }
    let mut canon = std::fs::canonicalize(&existing).map_err(|e| e.to_string())?;
    for name in tail.into_iter().rev() {
        let n = Path::new(&name);
        match n.components().next() {
            Some(Component::Normal(_)) if n.components().count() == 1 => canon.push(name),
            _ => return Err("Output directory contains '..' or '.' components".into()),
        }
    }
    Ok(canon)
}

/// Validate a publish-site output directory. The directory (existing or to be created)
/// must lie strictly inside one of `allowed_roots` (the user's home dir; on WSL also the
/// Windows profile dirs), must not be inside a hidden top-level dir of that root
/// (`~/.ssh`, `~/.minotes`, `~/.config`, …) or Windows `AppData`, and must not be an
/// existing non-directory. Returns the canonical path to write into.
pub fn validate_publish_dir(output_dir: &str, allowed_roots: &[PathBuf]) -> Result<PathBuf, String> {
    let p = Path::new(output_dir.trim());
    if output_dir.contains('\0') {
        return Err("Invalid output directory".into());
    }
    if !p.is_absolute() {
        return Err("Output directory must be an absolute path".into());
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Output directory must not contain '..'".into());
    }
    let canon = canonicalize_creatable(p)?;
    if canon.exists() && !canon.is_dir() {
        return Err("Output path exists and is not a directory".into());
    }
    for root in allowed_roots {
        let Ok(root) = std::fs::canonicalize(root) else { continue };
        let Ok(rel) = canon.strip_prefix(&root) else { continue };
        let mut comps = rel.components();
        let Some(Component::Normal(first)) = comps.next() else {
            // canon == root itself: refuse spraying HTML into the home dir root.
            continue;
        };
        let first = first.to_string_lossy();
        if first.starts_with('.') || first.eq_ignore_ascii_case("AppData") {
            return Err(format!("Refusing to publish into sensitive directory '{first}'"));
        }
        return Ok(canon);
    }
    Err("Output directory must be a folder inside your home directory".into())
}

// ── Outbound URL / IP policy (SSRF) ──

/// True if the address is anything other than a globally routable unicast address.
/// Covers loopback, RFC1918, CGNAT, link-local, unique-local, unspecified, multicast,
/// broadcast, documentation/benchmark ranges, and v4-mapped/NAT64 wrappers thereof.
pub fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_forbidden_v4(v4),
        IpAddr::V6(v6) => is_forbidden_v6(v6),
    }
}

fn is_forbidden_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || o[0] == 0                                   // 0.0.0.0/8 "this network"
        || (o[0] == 100 && (o[1] & 0xC0) == 64)        // 100.64.0.0/10 CGNAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)     // 192.0.0.0/24 IETF protocol
        || (o[0] == 198 && (o[1] & 0xFE) == 18)        // 198.18.0.0/15 benchmarking
        || o[0] >= 240                                 // 240.0.0.0/4 reserved
}

fn is_forbidden_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_forbidden_v4(v4);
    }
    let s = ip.segments();
    // NAT64 well-known prefix 64:ff9b::/96 — judge by the embedded v4 address.
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
        let v4 = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
        return is_forbidden_v4(v4);
    }
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (s[0] & 0xFE00) == 0xFC00                   // fc00::/7 unique local
        || (s[0] & 0xFFC0) == 0xFE80                   // fe80::/10 link local
        || (s[0] & 0xFFC0) == 0xFEC0                   // fec0::/10 site local (deprecated)
        || (s[0] == 0x2001 && s[1] == 0x0db8)          // 2001:db8::/32 documentation
        || s[0..6] == [0, 0, 0, 0, 0, 0]               // ::/96 v4-compatible (deprecated)
}

/// Check scheme and (if the host is an IP literal) the address of an outbound URL.
/// Hostnames are checked at DNS-resolution time by `SafeResolver`.
pub fn check_outbound_url(url: &reqwest::Url) -> Result<(), String> {
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Scheme '{other}' not allowed")),
    }
    let host = url.host_str().ok_or("URL has no host")?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        if is_forbidden_ip(ip) {
            return Err("Destination address not allowed".into());
        }
    } else if bare.eq_ignore_ascii_case("localhost") || bare.to_ascii_lowercase().ends_with(".localhost") {
        return Err("Destination address not allowed".into());
    }
    Ok(())
}

/// DNS resolver for reqwest that drops every non-public address. Because reqwest
/// connects to exactly the addresses this returns, this also defeats DNS rebinding
/// (there is no second lookup between "validate" and "connect").
pub struct SafeResolver;

impl reqwest::dns::Resolve for SafeResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs = tauri::async_runtime::spawn_blocking(move || {
                use std::net::ToSocketAddrs;
                (host.as_str(), 0u16).to_socket_addrs().map(|it| it.collect::<Vec<_>>())
            })
            .await
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.to_string().into() })??;
            let allowed: Vec<std::net::SocketAddr> =
                addrs.into_iter().filter(|a| !is_forbidden_ip(a.ip())).collect();
            if allowed.is_empty() {
                return Err("host resolves only to non-public addresses".into());
            }
            let iter: reqwest::dns::Addrs = Box::new(allowed.into_iter());
            Ok(iter)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_filename_accepts_plain_names() {
        assert_eq!(safe_png_filename("whiteboard-abc.png").unwrap(), "whiteboard-abc.png");
        assert_eq!(safe_png_filename("export").unwrap(), "export.png");
        assert_eq!(safe_png_filename("Shot.PNG").unwrap(), "Shot.png");
    }

    #[test]
    fn png_filename_rejects_traversal() {
        for bad in ["", ".", "..", "../x.png", "/etc/passwd", "a/b.png", "..\\x.png",
                    "C:\\x.png", "x\0.png", "x\n.png", ".png", "...png"] {
            assert!(safe_png_filename(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn graph_name_validation() {
        assert!(validate_graph_name("default").is_ok());
        assert!(validate_graph_name("work-notes_2").is_ok());
        for bad in ["", "..", "../../x", "a/b", "a\\b", "x.db", "a\0b"] {
            assert!(validate_graph_name(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn ip_classifier_blocks_internal() {
        for s in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
                  "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.1.2.3",
                  "224.0.0.1", "255.255.255.255", "198.18.0.1", "240.0.0.1",
                  "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
                  "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
                  "64:ff9b::a9fe:a9fe", "2001:db8::1", "::127.0.0.1"] {
            let ip: IpAddr = s.parse().unwrap();
            assert!(is_forbidden_ip(ip), "should block {s}");
        }
    }

    #[test]
    fn ip_classifier_allows_public() {
        for s in ["1.1.1.1", "8.8.8.8", "93.184.216.34", "100.128.0.1", "172.32.0.1",
                  "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"] {
            let ip: IpAddr = s.parse().unwrap();
            assert!(!is_forbidden_ip(ip), "should allow {s}");
        }
    }

    #[test]
    fn outbound_url_checks() {
        let ok = |s: &str| check_outbound_url(&reqwest::Url::parse(s).unwrap()).is_ok();
        assert!(ok("https://example.com/page"));
        assert!(ok("http://8.8.8.8/"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("ftp://example.com/"));
        assert!(!ok("http://127.0.0.1:8080/"));
        assert!(!ok("http://2130706433/")); // decimal form of 127.0.0.1
        assert!(!ok("http://0x7f.1/"));
        assert!(!ok("http://[::1]/"));
        assert!(!ok("http://[::ffff:169.254.169.254]/"));
        assert!(!ok("http://localhost/"));
        assert!(!ok("http://api.localhost/"));
    }

    #[test]
    fn safe_resolver_refuses_hostnames_resolving_to_loopback() {
        // Bypass check_outbound_url on purpose: the resolver alone must stop this.
        let res = tauri::async_runtime::block_on(async {
            let client = reqwest::Client::builder()
                .dns_resolver(std::sync::Arc::new(SafeResolver))
                .no_proxy()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap();
            client.get("http://localhost:9/").send().await
        });
        let err = res.expect_err("localhost must not be reachable");
        let chain = format!("{err:?}");
        assert!(chain.contains("non-public"), "unexpected error: {chain}");
    }

    #[test]
    fn image_path_validation() {
        let tmp = std::env::temp_dir().join(format!("minotes-sec-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let img = tmp.join("pic.png");
        std::fs::write(&img, b"\x89PNG").unwrap();
        let secret = tmp.join("secret.txt");
        std::fs::write(&secret, b"s3cret").unwrap();
        assert!(validate_image_path(img.to_str().unwrap()).is_ok());
        assert!(validate_image_path(secret.to_str().unwrap()).is_err());
        assert!(validate_image_path("relative.png").is_err());
        // A dir named like an image is refused.
        let dir = tmp.join("dir.png");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(validate_image_path(dir.to_str().unwrap()).is_err());
        #[cfg(unix)]
        {
            let link = tmp.join("evil.png");
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink(&secret, &link).unwrap();
            assert!(validate_image_path(link.to_str().unwrap()).is_err());
        }
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn pdf_path_validation() {
        let tmp = std::env::temp_dir().join(format!("minotes-pdf-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let pdf = tmp.join("Doc.PDF");
        std::fs::write(&pdf, b"%PDF-1.4").unwrap();
        let secret = tmp.join("secret.txt");
        std::fs::write(&secret, b"s3cret").unwrap();
        assert!(validate_pdf_path(pdf.to_str().unwrap(), None).is_ok());
        assert!(validate_pdf_path(secret.to_str().unwrap(), None).is_err());
        assert!(validate_pdf_path("relative.pdf", None).is_err());
        assert!(validate_pdf_path(tmp.join("missing.pdf").to_str().unwrap(), None).is_err());
        // `~/` expands against the given home; without one it stays relative → refused.
        assert!(validate_pdf_path("~/Doc.PDF", Some(&tmp)).is_ok());
        assert!(validate_pdf_path("~/Doc.PDF", None).is_err());
        let dir = tmp.join("dir.pdf");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(validate_pdf_path(dir.to_str().unwrap(), None).is_err());
        #[cfg(unix)]
        {
            let link = tmp.join("evil.pdf");
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink(&secret, &link).unwrap();
            assert!(validate_pdf_path(link.to_str().unwrap(), None).is_err());
        }
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn publish_dir_validation() {
        let root = std::env::temp_dir().join(format!("minotes-home-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".ssh")).unwrap();
        std::fs::create_dir_all(root.join("Documents")).unwrap();
        std::fs::write(root.join("file.txt"), b"x").unwrap();
        let roots = vec![root.clone()];
        let r = |p: PathBuf| validate_publish_dir(p.to_str().unwrap(), &roots);

        assert!(r(root.join("Documents")).is_ok());
        assert!(r(root.join("Documents/site/new")).is_ok()); // creatable
        assert!(r(root.clone()).is_err()); // home root itself
        assert!(r(root.join(".ssh")).is_err());
        assert!(r(root.join(".minotes/site")).is_err());
        assert!(r(root.join("file.txt")).is_err()); // not a dir
        assert!(r(root.join("Documents/../.ssh")).is_err());
        assert!(r(PathBuf::from("/etc/minotes-site")).is_err());
        assert!(validate_publish_dir("relative/dir", &roots).is_err());
        #[cfg(unix)]
        {
            let link = root.join("Documents/sneaky");
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink("/etc", &link).unwrap();
            assert!(r(link).is_err());
        }
        std::fs::remove_dir_all(&root).ok();
    }
}
