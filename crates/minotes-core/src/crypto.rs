//! Key material for encrypted notebooks (PRD-encryption §4.2).
//!
//! Envelope encryption: a random 256-bit **data key** (DEK) keys the SQLCipher
//! database. It is never derived from anything the user types. Two **key slots**
//! each hold the DEK wrapped (AES-256-GCM) by a key-encryption key:
//!
//! - the passphrase slot: KEK = Argon2id(passphrase, salt, m, t, p) — the
//!   parameters live in the slot, so they can be raised later;
//! - the recovery slot: KEK = HKDF-SHA256(recovery key), the recovery key being 32
//!   random bytes shown once to the user (see [`RecoveryKey`]).
//!
//! The slots are stored in `notebook.json` (`"encryption"`), outside the database
//! by necessity. A wrong passphrase is detected by the AES-GCM tag of the unwrap —
//! before SQLite is touched — so it is never confused with a damaged database.
//! Secret buffers are zeroized on drop ([`Zeroizing`]).

use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{Error, Result};

/// Argon2id defaults (PRD §4.2): 64 MiB, 3 passes, 4 lanes.
pub const ARGON2_M_KIB: u32 = 65536;
pub const ARGON2_T: u32 = 3;
pub const ARGON2_P: u32 = 4;

const HKDF_INFO_RECOVERY: &[u8] = b"minotes recovery kek v1";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const SALT_LEN: usize = 16;
/// Recovery key checksum: the first bytes of SHA-256 over the key.
const CHECKSUM_LEN: usize = 3;
const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Fill a buffer from the OS CSPRNG.
fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

// ── Data key ──

/// The notebook's data key (keys SQLCipher). Zeroized on drop.
#[derive(Clone)]
pub struct DataKey(Zeroizing<[u8; KEY_LEN]>);

impl DataKey {
    pub fn generate() -> DataKey {
        DataKey(Zeroizing::new(random::<KEY_LEN>()))
    }

    pub fn from_bytes(b: [u8; KEY_LEN]) -> DataKey {
        DataKey(Zeroizing::new(b))
    }

    pub fn bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }

    /// Lower-case hex (for the OS keychain entry). The caller must not keep it
    /// in a plain `String` longer than needed.
    pub fn to_hex(&self) -> Zeroizing<String> {
        let mut s = Zeroizing::new(String::with_capacity(KEY_LEN * 2));
        for b in self.0.iter() {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    pub fn from_hex(hex: &str) -> Result<DataKey> {
        let hex = hex.trim();
        if hex.len() != KEY_LEN * 2 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(Error::InvalidInput("Malformed data key".into()));
        }
        let mut out = [0u8; KEY_LEN];
        for (i, o) in out.iter_mut().enumerate() {
            *o = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                .map_err(|_| Error::InvalidInput("Malformed data key".into()))?;
        }
        Ok(DataKey::from_bytes(out))
    }

    /// The SQLCipher raw-key literal `x'…'` (64 hex digits): SQLCipher uses the
    /// bytes as the key directly and skips its own passphrase KDF.
    pub fn sqlcipher_literal(&self) -> Zeroizing<String> {
        let hex = self.to_hex();
        let mut s = Zeroizing::new(String::with_capacity(hex.len() + 3));
        s.push_str("x'");
        s.push_str(&hex);
        s.push('\'');
        s
    }
}

impl std::fmt::Debug for DataKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DataKey(…)")
    }
}

// ── Recovery key ──

/// 32 random bytes, shown once as 8 groups of 7 base32 characters (the key plus a
/// 3-byte SHA-256 checksum = 35 bytes = 56 characters).
pub struct RecoveryKey(Zeroizing<[u8; KEY_LEN]>);

impl RecoveryKey {
    pub fn generate() -> RecoveryKey {
        RecoveryKey(Zeroizing::new(random::<KEY_LEN>()))
    }

    /// `ABCDEFG-HIJKLMN-…` (8 groups).
    pub fn display(&self) -> Zeroizing<String> {
        let mut data = Zeroizing::new(Vec::with_capacity(KEY_LEN + CHECKSUM_LEN));
        data.extend_from_slice(&self.0[..]);
        data.extend_from_slice(&Sha256::digest(&self.0[..])[..CHECKSUM_LEN]);
        let chars = base32_encode(&data);
        let mut out = Zeroizing::new(String::with_capacity(63));
        for (i, c) in chars.chars().enumerate() {
            if i > 0 && i % 7 == 0 {
                out.push('-');
            }
            out.push(c);
        }
        out
    }

    /// Parse what the user typed: case, spaces and dashes are ignored. A
    /// checksum mismatch is a typo ("not a valid recovery key"), reported apart
    /// from a well-formed key that does not open this notebook.
    pub fn parse(text: &str) -> Result<RecoveryKey> {
        let cleaned: Zeroizing<String> = Zeroizing::new(
            text.chars()
                .filter(|c| !c.is_whitespace() && *c != '-')
                .map(|c| c.to_ascii_uppercase())
                .collect(),
        );
        let invalid = || Error::InvalidInput("This is not a valid recovery key — check for typos".into());
        if cleaned.len() != 56 {
            return Err(invalid());
        }
        let bytes = Zeroizing::new(base32_decode(&cleaned).ok_or_else(invalid)?);
        if bytes.len() != KEY_LEN + CHECKSUM_LEN {
            return Err(invalid());
        }
        let (key, sum) = bytes.split_at(KEY_LEN);
        if Sha256::digest(key)[..CHECKSUM_LEN] != *sum {
            return Err(invalid());
        }
        let mut k = [0u8; KEY_LEN];
        k.copy_from_slice(key);
        Ok(RecoveryKey(Zeroizing::new(k)))
    }

    fn kek(&self) -> Zeroizing<[u8; KEY_LEN]> {
        let hk = hkdf::Hkdf::<Sha256>::new(None, &self.0[..]);
        let mut out = Zeroizing::new([0u8; KEY_LEN]);
        hk.expand(HKDF_INFO_RECOVERY, &mut out[..]).expect("32 bytes is a valid HKDF length");
        out
    }
}

fn base32_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() * 8 / 5 + 1);
    let (mut buf, mut bits) = (0u32, 0u32);
    for &b in data {
        buf = (buf << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32[((buf >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = B32.iter().position(|&x| x == c)? as u32;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

// ── Slots ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlotType {
    Passphrase,
    Recovery,
}

impl SlotType {
    fn aad(self) -> &'static [u8] {
        match self {
            SlotType::Passphrase => b"minotes-dek-v1:passphrase",
            SlotType::Recovery => b"minotes-dek-v1:recovery",
        }
    }
}

/// One wrapped copy of the DEK (`notebook.json` → `encryption.slots[]`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Slot {
    #[serde(rename = "type")]
    pub slot_type: SlotType,
    /// "argon2id" (passphrase) or "hkdf-sha256" (recovery).
    pub kdf: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub m: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
    pub nonce: String,
    pub wrapped: String,
}

/// The `"encryption"` block of `notebook.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EncryptionInfo {
    pub version: u32,
    pub cipher: String,
    pub slots: Vec<Slot>,
}

/// Argon2id parameters (stored in the passphrase slot).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        KdfParams { m_kib: ARGON2_M_KIB, t: ARGON2_T, p: ARGON2_P }
    }
}

fn passphrase_kek(pass: &str, salt: &[u8], params: KdfParams) -> Result<Zeroizing<[u8; KEY_LEN]>> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let p = Params::new(params.m_kib, params.t, params.p, Some(KEY_LEN))
        .map_err(|e| Error::InvalidInput(format!("Unsupported key-derivation parameters: {e}")))?;
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, p)
        .hash_password_into(pass.as_bytes(), salt, &mut out[..])
        .map_err(|e| Error::InvalidInput(format!("Key derivation failed: {e}")))?;
    Ok(out)
}

fn wrap(kek: &[u8; KEY_LEN], dek: &DataKey, slot_type: SlotType) -> (String, String) {
    let cipher = Aes256Gcm::new_from_slice(kek).expect("32-byte key");
    let nonce = random::<NONCE_LEN>();
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: dek.bytes(), aad: slot_type.aad() })
        .expect("AES-GCM encryption of 32 bytes cannot fail");
    (B64.encode(nonce), B64.encode(ct))
}

/// `None` = the tag did not verify (wrong secret, or a tampered slot).
fn unwrap(kek: &[u8; KEY_LEN], slot: &Slot) -> Result<Option<DataKey>> {
    let bad = || Error::InvalidInput("The notebook's key slot is malformed".into());
    let nonce = B64.decode(&slot.nonce).map_err(|_| bad())?;
    let ct = B64.decode(&slot.wrapped).map_err(|_| bad())?;
    if nonce.len() != NONCE_LEN {
        return Err(bad());
    }
    let cipher = Aes256Gcm::new_from_slice(kek).expect("32-byte key");
    match cipher.decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad: slot.slot_type.aad() }) {
        Ok(pt) => {
            let pt = Zeroizing::new(pt);
            if pt.len() != KEY_LEN {
                return Err(bad());
            }
            let mut k = [0u8; KEY_LEN];
            k.copy_from_slice(&pt);
            Ok(Some(DataKey::from_bytes(k)))
        }
        Err(_) => Ok(None),
    }
}

fn passphrase_slot(dek: &DataKey, pass: &str, params: KdfParams) -> Result<Slot> {
    let salt = random::<SALT_LEN>();
    let kek = passphrase_kek(pass, &salt, params)?;
    let (nonce, wrapped) = wrap(&kek, dek, SlotType::Passphrase);
    Ok(Slot {
        slot_type: SlotType::Passphrase,
        kdf: "argon2id".into(),
        m: Some(params.m_kib),
        t: Some(params.t),
        p: Some(params.p),
        salt: Some(B64.encode(salt)),
        nonce,
        wrapped,
    })
}

fn recovery_slot(dek: &DataKey, rk: &RecoveryKey) -> Slot {
    let (nonce, wrapped) = wrap(&rk.kek(), dek, SlotType::Recovery);
    Slot { slot_type: SlotType::Recovery, kdf: "hkdf-sha256".into(), m: None, t: None, p: None, salt: None, nonce, wrapped }
}

/// The secret the user unlocks with.
pub enum Secret<'a> {
    Passphrase(&'a str),
    Recovery(&'a RecoveryKey),
}

impl EncryptionInfo {
    /// Slots for a new DEK: one passphrase slot and one recovery slot. Returns the
    /// recovery key to show the user (once).
    pub fn new(dek: &DataKey, pass: &str, params: KdfParams) -> Result<(EncryptionInfo, RecoveryKey)> {
        let rk = RecoveryKey::generate();
        let info = EncryptionInfo {
            version: 1,
            cipher: "sqlcipher4".into(),
            slots: vec![passphrase_slot(dek, pass, params)?, recovery_slot(dek, &rk)],
        };
        Ok((info, rk))
    }

    fn slot(&self, t: SlotType) -> Result<&Slot> {
        self.slots
            .iter()
            .find(|s| s.slot_type == t)
            .ok_or_else(|| Error::InvalidInput("The notebook has no key slot of that kind".into()))
    }

    /// Recover the DEK. A wrong passphrase / recovery key is [`Error::WrongPassphrase`].
    pub fn unlock(&self, secret: Secret<'_>) -> Result<DataKey> {
        if self.version != 1 {
            return Err(Error::InvalidInput(format!(
                "This notebook uses encryption format {} — please update MiNotes",
                self.version
            )));
        }
        let (slot, kek) = match secret {
            Secret::Passphrase(pass) => {
                let slot = self.slot(SlotType::Passphrase)?;
                if slot.kdf != "argon2id" {
                    return Err(Error::InvalidInput(format!("Unsupported key derivation '{}'", slot.kdf)));
                }
                let salt = B64
                    .decode(slot.salt.as_deref().unwrap_or_default())
                    .map_err(|_| Error::InvalidInput("The notebook's key slot is malformed".into()))?;
                let params = KdfParams {
                    m_kib: slot.m.unwrap_or(ARGON2_M_KIB),
                    t: slot.t.unwrap_or(ARGON2_T),
                    p: slot.p.unwrap_or(ARGON2_P),
                };
                (slot, passphrase_kek(pass, &salt, params)?)
            }
            Secret::Recovery(rk) => (self.slot(SlotType::Recovery)?, rk.kek()),
        };
        unwrap(&kek, slot)?.ok_or(Error::WrongPassphrase)
    }

    /// Replace the passphrase slot (the DEK and the database are unchanged).
    pub fn set_passphrase(&mut self, dek: &DataKey, new_pass: &str, params: KdfParams) -> Result<()> {
        let slot = passphrase_slot(dek, new_pass, params)?;
        self.replace(slot);
        Ok(())
    }

    /// Replace the recovery slot; the old recovery key stops working.
    pub fn regenerate_recovery(&mut self, dek: &DataKey) -> RecoveryKey {
        let rk = RecoveryKey::generate();
        self.replace(recovery_slot(dek, &rk));
        rk
    }

    fn replace(&mut self, slot: Slot) {
        match self.slots.iter_mut().find(|s| s.slot_type == slot.slot_type) {
            Some(s) => *s = slot,
            None => self.slots.push(slot),
        }
    }
}

// ── Passphrase strength ──

/// A small strength estimate (0 weak … 4 strong) — enough to refuse trivially
/// guessable passphrases (PRD §5: minimum "fair" = 2). The frontend has the same
/// rules for its meter (`lib/passphrase.ts`); the backend enforces them.
pub fn passphrase_strength(pass: &str) -> u8 {
    const COMMON: &[&str] = &[
        "password", "passw0rd", "123456", "12345678", "123456789", "qwerty", "qwertyuiop", "letmein",
        "iloveyou", "admin", "welcome", "monkey", "dragon", "football", "baseball", "abc123", "111111",
        "sunshine", "princess", "trustno1", "secret", "minotes", "changeme", "000000",
    ];
    let lower = pass.to_lowercase();
    if lower.trim().is_empty() || COMMON.iter().any(|c| lower == *c || lower.trim_end_matches(|ch: char| ch.is_ascii_digit() || ch == '!') == *c) {
        return 0;
    }
    let chars: Vec<char> = pass.chars().collect();
    let distinct = {
        let mut d = chars.clone();
        d.sort_unstable();
        d.dedup();
        d.len()
    };
    let classes = [
        chars.iter().any(|c| c.is_lowercase()),
        chars.iter().any(|c| c.is_uppercase()),
        chars.iter().any(|c| c.is_ascii_digit()),
        chars.iter().any(|c| !c.is_alphanumeric() && !c.is_whitespace()),
        chars.iter().any(|c| c.is_whitespace()),
    ]
    .iter()
    .filter(|b| **b)
    .count();
    // Rough entropy: effective length (distinct-limited) × bits per char.
    let pool: f64 = match classes {
        0 | 1 => 26.0,
        2 => 36.0,
        3 => 62.0,
        _ => 80.0,
    };
    let eff_len = (chars.len().min(distinct * 3)) as f64;
    let bits = eff_len * pool.log2();
    match bits {
        b if b < 28.0 => 0,
        b if b < 40.0 => 1,
        b if b < 60.0 => 2,
        b if b < 80.0 => 3,
        _ => 4,
    }
}

/// Minimum accepted strength ("fair").
pub const MIN_STRENGTH: u8 = 2;

pub fn check_passphrase(pass: &str) -> Result<()> {
    if passphrase_strength(pass) < MIN_STRENGTH {
        return Err(Error::InvalidInput(
            "That passphrase is too easy to guess — use a longer one (several words work well)".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Small Argon2 parameters keep the unit tests fast; the slot records them,
    /// which is exactly what lets parameters change later.
    const FAST: KdfParams = KdfParams { m_kib: 1024, t: 1, p: 1 };

    #[test]
    fn passphrase_round_trip_and_wrong_passphrase() {
        let dek = DataKey::generate();
        let (info, _rk) = EncryptionInfo::new(&dek, "correct horse battery", FAST).unwrap();
        let got = info.unlock(Secret::Passphrase("correct horse battery")).unwrap();
        assert_eq!(got.bytes(), dek.bytes());
        assert!(matches!(info.unlock(Secret::Passphrase("correct horse batterY")), Err(Error::WrongPassphrase)));
    }

    #[test]
    fn recovery_round_trip_display_parse_and_wrong_key() {
        let dek = DataKey::generate();
        let (info, rk) = EncryptionInfo::new(&dek, "correct horse battery", FAST).unwrap();
        let shown = rk.display();
        assert_eq!(shown.len(), 56 + 7, "8 groups of 7 with dashes: {}", &*shown);
        assert_eq!(shown.split('-').count(), 8);
        // Lower case and spaces are fine.
        let typed = shown.to_lowercase().replace('-', " ");
        let parsed = RecoveryKey::parse(&typed).unwrap();
        assert_eq!(info.unlock(Secret::Recovery(&parsed)).unwrap().bytes(), dek.bytes());
        // A different (valid) recovery key is a wrong key, not a typo.
        let other = RecoveryKey::generate();
        assert!(matches!(info.unlock(Secret::Recovery(&other)), Err(Error::WrongPassphrase)));
    }

    #[test]
    fn recovery_key_typo_is_caught_by_the_checksum() {
        let rk = RecoveryKey::generate();
        let mut s: Vec<char> = rk.display().chars().collect();
        s[3] = if s[3] == 'A' { 'B' } else { 'A' };
        let typo: String = s.into_iter().collect();
        let e = RecoveryKey::parse(&typo).err().unwrap();
        assert!(e.to_string().contains("not a valid recovery key"), "{e}");
        assert!(RecoveryKey::parse("ABC").is_err());
    }

    #[test]
    fn tampered_slot_is_rejected() {
        let dek = DataKey::generate();
        let (mut info, _rk) = EncryptionInfo::new(&dek, "correct horse battery", FAST).unwrap();
        let mut ct = B64.decode(&info.slots[0].wrapped).unwrap();
        ct[0] ^= 1;
        info.slots[0].wrapped = B64.encode(ct);
        assert!(matches!(info.unlock(Secret::Passphrase("correct horse battery")), Err(Error::WrongPassphrase)));
        // A slot swapped into the other type's place fails too (AAD binds the type).
        let (mut info2, _rk) = EncryptionInfo::new(&dek, "correct horse battery", FAST).unwrap();
        info2.slots[1].wrapped = info2.slots[0].wrapped.clone();
        info2.slots[1].nonce = info2.slots[0].nonce.clone();
        let rk = RecoveryKey::generate();
        assert!(matches!(info2.unlock(Secret::Recovery(&rk)), Err(Error::WrongPassphrase)));
    }

    #[test]
    fn argon2_parameters_are_read_from_the_slot() {
        let dek = DataKey::generate();
        let params = KdfParams { m_kib: 2048, t: 2, p: 2 };
        let (info, _) = EncryptionInfo::new(&dek, "correct horse battery", params).unwrap();
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["slots"][0]["m"], 2048);
        assert_eq!(json["slots"][0]["t"], 2);
        assert_eq!(json["slots"][0]["p"], 2);
        assert_eq!(json["slots"][0]["type"], "passphrase");
        assert_eq!(json["slots"][1]["kdf"], "hkdf-sha256");
        // Round-trips through JSON and still unlocks with the stored parameters.
        let back: EncryptionInfo = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back.unlock(Secret::Passphrase("correct horse battery")).unwrap().bytes(), dek.bytes());
        // Changing the stored parameters breaks the unlock (they are really used).
        let mut changed = json;
        changed["slots"][0]["t"] = serde_json::json!(3);
        let changed: EncryptionInfo = serde_json::from_value(changed).unwrap();
        assert!(matches!(changed.unlock(Secret::Passphrase("correct horse battery")), Err(Error::WrongPassphrase)));
    }

    #[test]
    fn default_parameters_work() {
        let dek = DataKey::generate();
        let (info, _) = EncryptionInfo::new(&dek, "correct horse battery", KdfParams::default()).unwrap();
        assert_eq!(info.slots[0].m, Some(65536));
        assert_eq!(info.unlock(Secret::Passphrase("correct horse battery")).unwrap().bytes(), dek.bytes());
    }

    #[test]
    fn change_passphrase_and_regenerate_recovery() {
        let dek = DataKey::generate();
        let (mut info, old_rk) = EncryptionInfo::new(&dek, "correct horse battery", FAST).unwrap();
        let recovery_before = info.slots[1].clone();
        info.set_passphrase(&dek, "a brand new passphrase", FAST).unwrap();
        assert!(matches!(info.unlock(Secret::Passphrase("correct horse battery")), Err(Error::WrongPassphrase)));
        assert_eq!(info.unlock(Secret::Passphrase("a brand new passphrase")).unwrap().bytes(), dek.bytes());
        assert_eq!(info.slots[1], recovery_before, "the recovery slot is untouched");
        let new_rk = info.regenerate_recovery(&dek);
        assert!(matches!(info.unlock(Secret::Recovery(&old_rk)), Err(Error::WrongPassphrase)));
        assert_eq!(info.unlock(Secret::Recovery(&new_rk)).unwrap().bytes(), dek.bytes());
    }

    #[test]
    fn newer_format_is_refused() {
        let dek = DataKey::generate();
        let (mut info, _) = EncryptionInfo::new(&dek, "correct horse battery", FAST).unwrap();
        info.version = 2;
        let e = info.unlock(Secret::Passphrase("correct horse battery")).err().unwrap();
        assert!(e.to_string().contains("update MiNotes"), "{e}");
    }

    #[test]
    fn data_key_hex_and_sqlcipher_literal() {
        let dek = DataKey::from_bytes([0xab; 32]);
        assert_eq!(&*dek.to_hex(), &"ab".repeat(32));
        assert_eq!(DataKey::from_hex(&dek.to_hex()).unwrap().bytes(), dek.bytes());
        assert!(DataKey::from_hex("zz").is_err());
        assert_eq!(&*dek.sqlcipher_literal(), &format!("x'{}'", "ab".repeat(32)));
        assert_eq!(format!("{dek:?}"), "DataKey(…)");
    }

    #[test]
    fn strength_estimate() {
        for weak in ["", "password", "Password1", "123456", "aaaaaaaaaaaa", "qwerty", "abc"] {
            assert!(passphrase_strength(weak) < MIN_STRENGTH, "{weak:?} should be weak");
        }
        for ok in ["correct horse battery", "Tr0ub4dor&3x", "blue-kettle-sings-9"] {
            assert!(passphrase_strength(ok) >= MIN_STRENGTH, "{ok:?} should be acceptable");
        }
        assert!(check_passphrase("password").is_err());
        assert!(check_passphrase("correct horse battery").is_ok());
    }
}
