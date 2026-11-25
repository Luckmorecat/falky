use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use chrono::{DateTime, Utc};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use crate::{
    model::Secret,
    transport::{Origin, credential::SessionCredential},
};

use super::Error;

#[derive(Clone, Debug)]
pub struct OriginStore {
    pub(super) path: Option<PathBuf>,
}

impl Default for OriginStore {
    fn default() -> Self {
        Self {
            path: ProjectDirs::from("", "Falky", "Falky")
                .map(|dirs| dirs.config_dir().join("origin.json")),
        }
    }
}

impl OriginStore {
    pub fn at(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    pub fn load(&self) -> Result<Option<Origin>, Error> {
        let path = self.path.as_ref().ok_or(Error::OriginStorage)?;
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| Error::OriginStorage),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(Error::OriginStorage),
        }
    }

    pub fn save(&self, origin: &Origin) -> Result<(), Error> {
        let path = self.path.as_ref().ok_or(Error::OriginStorage)?;
        let parent = path.parent().ok_or(Error::OriginStorage)?;
        fs::create_dir_all(parent).map_err(|_| Error::OriginStorage)?;
        let temp = parent.join(format!(".origin-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            serde_json::to_writer(&mut file, origin)?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result.map_err(|_| Error::OriginStorage)
    }
}

pub(super) struct SavedCredential {
    pub(super) cookie: SessionCredential,
    pub(super) expires_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
struct VaultRecord {
    token: String,
    expires_at: DateTime<Utc>,
}

pub(super) struct Keyring;

impl Keyring {
    pub(super) async fn load(origin: Origin) -> Result<Option<SavedCredential>, ()> {
        tokio::task::spawn_blocking(move || {
            let record = with_entry(&origin, read)?;
            Ok(record.map(|record| SavedCredential {
                cookie: SessionCredential {
                    origin,
                    secret: Secret::new(record.token),
                },
                expires_at: record.expires_at,
            }))
        })
        .await
        .map_err(|_| ())?
    }

    pub(super) async fn save(saved: SavedCredential) -> bool {
        tokio::task::spawn_blocking(move || {
            let record = serde_json::to_string(&VaultRecord {
                token: saved.cookie.secret.expose_secret().to_owned(),
                expires_at: saved.expires_at,
            })
            .map_err(|_| ())?;
            with_entry(&saved.cookie.origin, |entry| {
                entry.set_password(&record).map_err(|_| ())
            })
        })
        .await
        .is_ok_and(|result| result.is_ok())
    }

    pub(super) async fn forget(cookie: SessionCredential) -> bool {
        tokio::task::spawn_blocking(move || {
            with_entry(&cookie.origin, |entry| {
                // A stale session may be revoked after another instance signs in.
                if read(entry)?.is_some_and(|record| record.token == cookie.secret.expose_secret())
                {
                    match entry.delete_credential() {
                        Ok(()) | Err(keyring::Error::NoEntry) => {}
                        Err(_) => return Err(()),
                    }
                }
                Ok(())
            })
        })
        .await
        .is_ok_and(|result: Result<(), ()>| result.is_ok())
    }
}

fn with_entry<T>(
    origin: &Origin,
    work: impl FnOnce(&keyring::Entry) -> Result<T, ()>,
) -> Result<T, ()> {
    let dirs = ProjectDirs::from("", "Falky", "Falky").ok_or(())?;
    let lock = open_origin_lock(&dirs.config_local_dir().join("credential-locks"), origin)
        .map_err(|_| ())?;
    lock.lock().map_err(|_| ())?;
    let entry = keyring::Entry::new("Falky desktop account", origin.as_str()).map_err(|_| ())?;
    work(&entry)
}

fn open_origin_lock(directory: &Path, origin: &Origin) -> io::Result<fs::File> {
    // Use stable FNV-1a naming across app versions. A collision only shares a lock.
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in origin.as_str().bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
    }
    fs::create_dir_all(directory)?;
    // Leave the inode in place so opening it always joins the same lock.
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join(format!("{hash:016x}.lock")))
}

fn read(entry: &keyring::Entry) -> Result<Option<VaultRecord>, ()> {
    match entry.get_password() {
        Ok(record) => serde_json::from_str(&record).map(Some).map_err(|_| ()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_lock_serializes_independent_handles_for_the_same_origin() {
        let directory = tempfile::tempdir().unwrap();
        let first = Origin::parse("https://falky.example").unwrap();
        let same = Origin::parse("https://Falky.EXAMPLE:443/").unwrap();
        let other = Origin::parse("https://other.example").unwrap();
        let held = open_origin_lock(directory.path(), &first).unwrap();
        held.lock().unwrap();
        let contender = open_origin_lock(directory.path(), &same).unwrap();
        assert!(matches!(
            contender.try_lock(),
            Err(fs::TryLockError::WouldBlock)
        ));
        let other = open_origin_lock(directory.path(), &other).unwrap();
        other.try_lock().unwrap();
        drop(held);
        contender.try_lock().unwrap();
        assert_eq!(contender.metadata().unwrap().len(), 0);
    }
}
