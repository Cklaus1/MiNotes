//! "Keep unlocked on this device" (PRD-encryption §4.3): an encrypted notebook's
//! data key in the OS keychain (macOS Keychain, Windows Credential Manager, Linux
//! Secret Service), keyed by notebook id.
//!
//! Never falls back to a file: where no keychain works (headless Linux, WSL
//! without a secret service, Android — `keyring` is not compiled there) the
//! option is unavailable. Debug builds only: `MINOTES_FAKE_KEYCHAIN_DIR` swaps in
//! a directory-backed store so the real app's journeys can test the flow without
//! touching the developer's keychain (ignored by release builds).

use crate::crypto::DataKey;
use crate::error::{Error, Result};

const SERVICE: &str = "minotes-notebook-key";

/// How long one keychain call may take. On Linux with no running secret service,
/// a call makes D-Bus try to start one and can block for up to two minutes.
const KEYCHAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Set once a keychain call timed out: the keychain is treated as unavailable for
/// the rest of this process instead of stalling every later call.
static UNRESPONSIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Run an OS keychain call off the caller's thread with a time limit. `None` when
/// the keychain didn't answer in time (or already stopped answering earlier) —
/// callers treat that as "no keychain". The abandoned call finishes on its own.
pub fn guarded<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    use std::sync::atomic::Ordering;
    if UNRESPONSIVE.load(Ordering::Relaxed) {
        return None;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("minotes-keychain".into())
        .spawn(move || {
            let _ = tx.send(f());
        })
        .ok()?;
    match rx.recv_timeout(KEYCHAIN_TIMEOUT) {
        Ok(v) => Some(v),
        Err(_) => {
            UNRESPONSIVE.store(true, Ordering::Relaxed);
            None
        }
    }
}

#[cfg(debug_assertions)]
fn fake_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("MINOTES_FAKE_KEYCHAIN_DIR").filter(|v| !v.is_empty()).map(std::path::PathBuf::from)
}

#[cfg(not(debug_assertions))]
fn fake_dir() -> Option<std::path::PathBuf> {
    None
}

fn fake_path(dir: &std::path::Path, notebook_key: &str) -> std::path::PathBuf {
    let safe: String = notebook_key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    dir.join(format!("{SERVICE}-{safe}"))
}

#[cfg(not(target_os = "android"))]
fn entry(notebook_key: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, notebook_key).map_err(|e| Error::InvalidInput(format!("Keychain: {e}")))
}

/// Can this device remember keys? (A missing entry still means it works.)
pub fn available() -> bool {
    if fake_dir().is_some() {
        return true;
    }
    #[cfg(not(target_os = "android"))]
    {
        guarded(|| {
            matches!(
                keyring::Entry::new(SERVICE, "availability-probe").and_then(|e| e.get_password()),
                Ok(_) | Err(keyring::Error::NoEntry)
            )
        })
        .unwrap_or(false)
    }
    #[cfg(target_os = "android")]
    {
        false
    }
}

/// Store `key` for `notebook_key`.
pub fn remember(notebook_key: &str, key: &DataKey) -> Result<()> {
    if let Some(dir) = fake_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| Error::InvalidInput(e.to_string()))?;
        return std::fs::write(fake_path(&dir, notebook_key), key.to_hex().as_bytes())
            .map_err(|e| Error::InvalidInput(e.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    {
        let (nb, hex) = (notebook_key.to_string(), zeroize::Zeroizing::new(key.to_hex()));
        guarded(move || {
            entry(&nb)?
                .set_password(&hex)
                .map_err(|e| Error::InvalidInput(format!("Could not store the key in the keychain: {e}")))
        })
        .unwrap_or_else(|| Err(Error::InvalidInput("The keychain is not responding".into())))
    }
    #[cfg(target_os = "android")]
    {
        let _ = key;
        Err(Error::InvalidInput("This device has no keychain MiNotes can use".into()))
    }
}

/// The remembered key, if any. A keychain error reads as "not remembered".
pub fn recall(notebook_key: &str) -> Option<DataKey> {
    if let Some(dir) = fake_dir() {
        let hex = zeroize::Zeroizing::new(std::fs::read_to_string(fake_path(&dir, notebook_key)).ok()?);
        return DataKey::from_hex(&hex).ok();
    }
    #[cfg(not(target_os = "android"))]
    {
        let nb = notebook_key.to_string();
        let hex = guarded(move || entry(&nb).ok()?.get_password().ok().map(zeroize::Zeroizing::new))??;
        DataKey::from_hex(&hex).ok()
    }
    #[cfg(target_os = "android")]
    {
        None
    }
}

/// Is a key remembered for `notebook_key`?
pub fn is_remembered(notebook_key: &str) -> bool {
    recall(notebook_key).is_some()
}

/// "Forget on this device".
pub fn forget(notebook_key: &str) {
    if let Some(dir) = fake_dir() {
        let _ = std::fs::remove_file(fake_path(&dir, notebook_key));
        return;
    }
    #[cfg(not(target_os = "android"))]
    {
        let nb = notebook_key.to_string();
        let _ = guarded(move || {
            if let Ok(e) = entry(&nb) {
                let _ = e.delete_credential();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only the debug-build fake store is exercised: tests never touch the
    /// developer's real keychain.
    #[test]
    fn fake_store_round_trip() {
        let _home = crate::notebook::tests::FakeHome::new(); // serialises env changes
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("MINOTES_FAKE_KEYCHAIN_DIR", dir.path());
        assert!(available());
        let key = DataKey::generate();
        assert!(!is_remembered("nb-1"));
        remember("nb-1", &key).unwrap();
        assert_eq!(recall("nb-1").unwrap().bytes(), key.bytes());
        assert!(recall("nb-2").is_none());
        forget("nb-1");
        assert!(recall("nb-1").is_none());
        // Odd ids cannot escape the directory.
        remember("../x", &key).unwrap();
        assert!(dir.path().join(format!("{SERVICE}-___x")).is_file());
        std::env::remove_var("MINOTES_FAKE_KEYCHAIN_DIR");
    }

    /// A keychain that never answers (no secret service on Linux) costs one short
    /// wait, then is skipped — callers never block for minutes.
    #[test]
    fn unresponsive_keychain_times_out_and_is_skipped() {
        use std::sync::atomic::Ordering;
        use std::time::{Duration, Instant};
        UNRESPONSIVE.store(false, Ordering::Relaxed);
        assert_eq!(guarded(|| 7), Some(7));
        let t = Instant::now();
        assert_eq!(guarded(|| std::thread::sleep(Duration::from_secs(30))), None);
        assert!(t.elapsed() < KEYCHAIN_TIMEOUT + Duration::from_secs(2), "{:?}", t.elapsed());
        let t = Instant::now();
        assert_eq!(guarded(|| 7), None, "skipped once it stopped answering");
        assert!(t.elapsed() < Duration::from_millis(100));
        UNRESPONSIVE.store(false, Ordering::Relaxed);
    }
}
