use std::{
    fs::{self, OpenOptions},
    io::{self, BufReader, Write},
    path::Path,
};

use serde::{Deserialize, Serialize};

use crate::{Origin, model::VisitorId};

use super::ReadState;

#[derive(Serialize, Deserialize)]
struct ScopedReadState {
    origin: Origin,
    identity: VisitorId,
    read: ReadState,
}

impl ReadState {
    pub fn load(path: &Path, origin: &Origin, identity: &VisitorId) -> io::Result<Self> {
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error),
        };
        let file: ScopedReadState = serde_json::from_reader(BufReader::new(file))?;
        if file.origin == *origin && file.identity == *identity {
            Ok(file.read)
        } else {
            Ok(Self::default())
        }
    }

    pub fn save(&self, path: &Path, origin: &Origin, identity: &VisitorId) -> io::Result<()> {
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty());
        if let Some(parent) = parent {
            fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            serde_json::to_writer(
                &mut file,
                &ScopedReadState {
                    origin: origin.clone(),
                    identity: identity.clone(),
                    read: self.clone(),
                },
            )?;
            file.flush()?;
            drop(file);
            fs::rename(&temporary, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }

    pub fn clear(path: &Path) -> io::Result<()> {
        match fs::remove_file(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }
}
