//! Encrypted, signed grants that disclose one payment record to one reviewer.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use styx_core::encoding::{EncodingError, Reader, Writer};
use styx_core::suite;
use zeroize::Zeroizing;

use crate::identity::{AuthorizationIdentity, DisclosureIdentity};

/// Largest record a grant can carry.
pub const MAX_DISCLOSURE_BYTES: usize = 48 * 1024 * 1024;

/// A recipient-bound, issuer-signed encrypted grant for one record.
#[derive(Clone)]
pub struct DisclosureGrant {
    /// Issuer address.
    /// The recipient must obtain the expected identity independently.
    pub issuer: Vec<u8>,
    /// Intended disclosure recipient's X25519 public key.
    pub recipient: [u8; 32],
    /// Record selected by this grant.
    pub deal_id: [u8; 16],
    /// Unix time after which a recipient must reject the grant.
    pub expires_at: u64,
    handshake: Vec<u8>,
    frames: Vec<Vec<u8>>,
    version: u16,
    signature: Vec<u8>,
}

impl core::fmt::Debug for DisclosureGrant {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str("DisclosureGrant { <redacted> }")
    }
}

/// Grant creation or opening failed.
#[derive(Debug, thiserror::Error)]
pub enum GrantError {
    /// Grant structure or issuer signature is invalid.
    #[error("invalid disclosure grant")]
    Invalid,
    /// Recipient key does not match the signed grant.
    #[error("grant belongs to a different recipient")]
    WrongRecipient,
    /// The grant is past its acceptance deadline.
    #[error("grant has expired")]
    Expired,
    /// Encryption or decryption failed.
    #[error("disclosure encryption failed")]
    Cryptography,
    /// The encoded grant could not be parsed.
    #[error(transparent)]
    Encoding(#[from] EncodingError),
    /// A grant backup could not be read or written.
    #[error("grant backup I/O failed")]
    Backup,
}

const RECORD_GRANT_DOMAIN: &[u8] = b"STYX_RECORD_DISCLOSURE_V3";
const RECORD_GRANT_VERSION: u16 = 3;
const NOISE_N: &str = "Noise_N_25519_ChaChaPoly_BLAKE2s";
const CHUNK_BYTES: usize = 60_000;
const MAX_FRAME_BYTES: usize = 65_535;
/// Maximum encoded grant bytes, including encryption and signature framing.
pub const MAX_GRANT_BYTES: usize = MAX_DISCLOSURE_BYTES + 1024 * 1024;

impl DisclosureGrant {
    /// Encodes the recipient-bound grant for transfer or local backup.
    pub fn encode(&self) -> Result<Vec<u8>, GrantError> {
        if !matches!(
            (self.version, self.issuer.len(), self.signature.len()),
            (RECORD_GRANT_VERSION, 20, 65)
        ) {
            return Err(GrantError::Invalid);
        }
        let mut writer = Writer::new();
        writer.u16(self.version);
        writer.fixed(&self.issuer);
        writer.fixed(&self.recipient);
        writer.fixed(&self.deal_id);
        writer.u64(self.expires_at);
        writer.bytes(&self.handshake);
        writer.u32(self.frames.len() as u32);
        for frame in &self.frames {
            writer.bytes_bounded(frame, MAX_FRAME_BYTES);
        }
        writer.fixed(&self.signature);
        let bytes = writer.finish();
        if bytes.len() > MAX_GRANT_BYTES {
            return Err(GrantError::Invalid);
        }
        Ok(bytes)
    }

    /// Decodes an entire grant. Opening also checks the signature and recipient.
    pub fn decode(bytes: &[u8]) -> Result<Self, GrantError> {
        if bytes.len() > MAX_GRANT_BYTES {
            return Err(GrantError::Invalid);
        }
        let mut reader = Reader::new(bytes);
        let version = reader.u16("grant_version")?;
        if version != RECORD_GRANT_VERSION {
            return Err(GrantError::Invalid);
        }
        let issuer = reader.fixed::<20>("issuer")?.to_vec();
        let recipient = reader.fixed("recipient")?;
        let deal_id = reader.fixed("deal_id")?;
        let expires_at = reader.u64("expires_at")?;
        let handshake = reader.bytes("handshake", 1, MAX_FRAME_BYTES)?.to_vec();
        let count = reader.u32("frame_count")? as usize;
        if count == 0 || count > MAX_DISCLOSURE_BYTES / CHUNK_BYTES + 1 {
            return Err(GrantError::Invalid);
        }
        let mut frames = Vec::with_capacity(count);
        for _ in 0..count {
            frames.push(reader.bytes("frame", 16, MAX_FRAME_BYTES)?.to_vec());
        }
        let signature = reader.fixed::<65>("signature")?.to_vec();
        reader.finish()?;
        Ok(Self {
            issuer,
            recipient,
            deal_id,
            expires_at,
            handshake,
            frames,
            signature,
            version,
        })
    }

    /// Writes one owner-only backup without replacing an existing file.
    /// The file may be partial after an I/O failure; `load_backup` rejects it.
    pub fn write_backup(&self, path: impl AsRef<Path>) -> Result<(), GrantError> {
        let path = path.as_ref();
        let bytes = self.encode()?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(path).map_err(|_| GrantError::Backup)?;
        file.write_all(&bytes).map_err(|_| GrantError::Backup)?;
        file.sync_all().map_err(|_| GrantError::Backup)?;
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| GrantError::Backup)?;
        Ok(())
    }

    /// Loads a grant from an owner-only backup file.
    pub fn load_backup(path: impl AsRef<Path>) -> Result<Self, GrantError> {
        let path = path.as_ref();
        #[cfg(unix)]
        if fs::metadata(path)
            .map_err(|_| GrantError::Backup)?
            .permissions()
            .mode()
            & 0o077
            != 0
        {
            return Err(GrantError::Backup);
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .and_then(|file| {
                file.take((MAX_GRANT_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
            })
            .map_err(|_| GrantError::Backup)?;
        Self::decode(&bytes)
    }

    /// Encrypts one record for a recipient and signs it as a version 3 grant.
    ///
    /// Versions 1 and 2 carry a [`SelectedAgreement`] and are unchanged. A record grant has its
    /// own version and signing domain, so neither kind can be presented as the other.
    /// `record_id` is bound into the signed header; the opener must compare it to the record.
    pub fn seal_record(
        record: &[u8],
        record_id: [u8; 16],
        issuer: &AuthorizationIdentity,
        recipient: [u8; 32],
        expires_at: u64,
        now: u64,
    ) -> Result<Self, GrantError> {
        if now >= expires_at || recipient == [0; 32] {
            return Err(GrantError::Invalid);
        }
        if record.is_empty() || record.len() > MAX_DISCLOSURE_BYTES {
            return Err(GrantError::Invalid);
        }
        let mut grant = Self::encrypt_bytes(
            record,
            issuer.address().to_vec(),
            RECORD_GRANT_VERSION,
            recipient,
            record_id,
            expires_at,
        )?;
        grant.signature = issuer.sign_digest(&grant.signature_digest()).to_vec();
        Ok(grant)
    }

    fn encrypt_bytes(
        plaintext: &[u8],
        issuer: Vec<u8>,
        version: u16,
        recipient: [u8; 32],
        deal_id: [u8; 16],
        expires_at: u64,
    ) -> Result<Self, GrantError> {
        let mut grant = Self {
            issuer,
            recipient,
            deal_id,
            expires_at,
            handshake: Vec::new(),
            frames: Vec::new(),
            signature: Vec::new(),
            version,
        };
        let prologue = grant.header_digest();
        let params = NOISE_N.parse().map_err(|_| GrantError::Cryptography)?;
        let mut handshake = snow::Builder::new(params)
            .prologue(&prologue)
            .remote_public_key(&recipient)
            .build_initiator()
            .map_err(|_| GrantError::Cryptography)?;
        let mut buffer = vec![0u8; MAX_FRAME_BYTES];
        let written = handshake
            .write_message(&[], &mut buffer)
            .map_err(|_| GrantError::Cryptography)?;
        grant.handshake = buffer[..written].to_vec();
        let mut channel = handshake
            .into_transport_mode()
            .map_err(|_| GrantError::Cryptography)?;
        for chunk in plaintext.chunks(CHUNK_BYTES) {
            let written = channel
                .write_message(chunk, &mut buffer)
                .map_err(|_| GrantError::Cryptography)?;
            grant.frames.push(buffer[..written].to_vec());
        }
        Ok(grant)
    }

    /// Opens a version 3 record grant. This authenticates and decrypts only: the caller compares
    /// `deal_id` to the record's own ID and verifies the record's contents.
    pub fn open_record(
        &self,
        recipient: &DisclosureIdentity,
        expected_issuer: impl AsRef<[u8]>,
        now: u64,
    ) -> Result<Zeroizing<Vec<u8>>, GrantError> {
        self.check_envelope(recipient, expected_issuer.as_ref(), now)?;
        if self.version != RECORD_GRANT_VERSION {
            return Err(GrantError::Invalid);
        }
        suite::suite(1)
            .map_err(|_| GrantError::Invalid)?
            .verify_authorization(&self.issuer, &self.signature_digest(), &self.signature)
            .map_err(|_| GrantError::Invalid)?;
        self.decrypt(recipient)
    }

    fn check_envelope(
        &self,
        recipient: &DisclosureIdentity,
        expected_issuer: &[u8],
        now: u64,
    ) -> Result<(), GrantError> {
        if recipient.public_key() != self.recipient {
            return Err(GrantError::WrongRecipient);
        }
        if now >= self.expires_at {
            return Err(GrantError::Expired);
        }
        if expected_issuer != self.issuer
            || self.handshake.is_empty()
            || self.handshake.len() > MAX_FRAME_BYTES
            || self.frames.is_empty()
            || self.frames.len() > MAX_DISCLOSURE_BYTES / CHUNK_BYTES + 1
            || self
                .frames
                .iter()
                .any(|frame| frame.len() < 16 || frame.len() > MAX_FRAME_BYTES)
        {
            return Err(GrantError::Invalid);
        }
        Ok(())
    }

    fn decrypt(&self, recipient: &DisclosureIdentity) -> Result<Zeroizing<Vec<u8>>, GrantError> {
        let prologue = self.header_digest();
        let params = NOISE_N.parse().map_err(|_| GrantError::Cryptography)?;
        let mut handshake = snow::Builder::new(params)
            .prologue(&prologue)
            .local_private_key(recipient.private_key())
            .build_responder()
            .map_err(|_| GrantError::Cryptography)?;
        let mut buffer = vec![0u8; MAX_FRAME_BYTES];
        handshake
            .read_message(&self.handshake, &mut buffer)
            .map_err(|_| GrantError::Cryptography)?;
        let mut channel = handshake
            .into_transport_mode()
            .map_err(|_| GrantError::Cryptography)?;
        let mut plaintext = Zeroizing::new(Vec::new());
        for frame in &self.frames {
            let read = channel
                .read_message(frame, &mut buffer)
                .map_err(|_| GrantError::Cryptography)?;
            if plaintext
                .len()
                .checked_add(read)
                .is_none_or(|length| length > MAX_DISCLOSURE_BYTES)
            {
                return Err(GrantError::Invalid);
            }
            plaintext.extend_from_slice(&buffer[..read]);
        }
        Ok(plaintext)
    }

    fn header_digest(&self) -> [u8; 32] {
        suite::keccak256(&[
            self.domain(),
            &self.issuer,
            &self.recipient,
            &self.deal_id,
            &self.expires_at.to_be_bytes(),
        ])
    }

    fn signature_digest(&self) -> [u8; 32] {
        let mut writer = Writer::new();
        writer.fixed(&self.header_digest());
        writer.bytes(&self.handshake);
        writer.u32(self.frames.len() as u32);
        for frame in &self.frames {
            writer.bytes_bounded(frame, MAX_FRAME_BYTES);
        }
        suite::keccak256(&[self.domain(), &writer.finish()])
    }

    fn domain(&self) -> &'static [u8] {
        RECORD_GRANT_DOMAIN
    }
}
