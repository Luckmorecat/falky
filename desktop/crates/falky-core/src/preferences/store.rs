use serde::{Serialize, de::DeserializeOwned};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PreferenceFileError {
    #[error("No application configuration directory is available.")]
    NoConfigDirectory,
    #[error("Could not access the preference file.")]
    Io(#[from] io::Error),
    #[error("The preference file could not be read or encoded.")]
    Json(#[from] serde_json::Error),
}

/// Atomic storage for local presentation settings. Session authority belongs to the keyring.
#[derive(Clone, Debug)]
pub struct PreferenceStore {
    path: PathBuf,
}

impl PreferenceStore {
    pub fn platform() -> Result<Self, PreferenceFileError> {
        let dirs = directories::ProjectDirs::from("", "Falky", "Falky")
            .ok_or(PreferenceFileError::NoConfigDirectory)?;
        Ok(Self::at(dirs.config_dir().join("preferences.json")))
    }

    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load<T: DeserializeOwned + Default>(&self) -> Result<T, PreferenceFileError> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(T::default()),
            Err(error) => return Err(error.into()),
        };
        Ok(serde_json::from_reader(BufReader::new(file))?)
    }

    pub fn save(&self, value: &impl Serialize) -> Result<(), PreferenceFileError> {
        let parent = self
            .path
            .parent()
            .filter(|path| !path.as_os_str().is_empty());
        let directory = parent.unwrap_or(Path::new("."));
        fs::create_dir_all(directory)?;
        let temporary = directory.join(format!(".preferences-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&temporary)?;
        let result = self.replace_from(&temporary, file, value);
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn replace_from(
        &self,
        temporary: &Path,
        mut file: File,
        value: &impl Serialize,
    ) -> Result<(), PreferenceFileError> {
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        fs::rename(temporary, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serializer};

    #[derive(Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
    struct Fixture {
        value: String,
    }

    struct Failing;

    impl Serialize for Failing {
        fn serialize<S: Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("interrupted encoding"))
        }
    }

    #[test]
    fn restart_recovers_the_last_complete_write() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("nested").join("prefs.json");
        let store = PreferenceStore::at(&file);
        assert_eq!(store.load::<Fixture>().unwrap(), Fixture::default());
        let first = Fixture {
            value: "Voice".into(),
        };
        store.save(&first).unwrap();
        assert!(matches!(
            store.save(&Failing),
            Err(PreferenceFileError::Json(_))
        ));
        let restarted = PreferenceStore::at(&file);
        assert_eq!(restarted.load::<Fixture>().unwrap(), first);
        assert_eq!(file.parent().unwrap().read_dir().unwrap().count(), 1);
        let second = Fixture {
            value: "Голос".into(),
        };
        restarted.save(&second).unwrap();
        assert_eq!(store.load::<Fixture>().unwrap(), second);
    }

    #[test]
    fn reports_corruption_before_replacing_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("prefs.json");
        fs::write(&file, b"{").unwrap();
        assert!(matches!(
            PreferenceStore::at(&file).load::<Fixture>(),
            Err(PreferenceFileError::Json(_))
        ));
        assert_eq!(fs::read(&file).unwrap(), b"{");
    }
}
