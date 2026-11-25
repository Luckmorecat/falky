use cpal::{
    Device, DeviceId, Host,
    traits::{DeviceTrait, HostTrait},
};

pub(super) fn saved_id(id: &DeviceId) -> Option<String> {
    // CPAL uses CoreAudio device UIDs and WASAPI endpoint IDs. ALSA IDs are PCM
    // routes, and the card in a hardware route can be reassigned on unplug.
    #[cfg(target_os = "linux")]
    if id.0 == cpal::HostId::Alsa {
        return alsa_id(&id.1, std::path::Path::new("/sys/class/sound"));
    }
    Some(format!("cpal:{id}"))
}

pub(super) fn explicit_device(host: &Host, selected: &str) -> Option<Device> {
    if let Some(id) = selected.strip_prefix("cpal:") {
        let id: DeviceId = id.parse().ok()?;
        if id.0 != host.id() || saved_id(&id).as_deref() != Some(selected) {
            return None;
        }
        return host.device_by_id(&id);
    }
    #[cfg(target_os = "linux")]
    if selected.starts_with("alsa-card:") {
        // ALSA hints and numeric aliases can describe the same verified PCM.
        return host.devices().ok()?.find(|device| {
            device.id().ok().as_ref().and_then(saved_id).as_deref() == Some(selected)
        });
    }
    None
}

#[cfg(target_os = "linux")]
fn alsa_id(pcm: &str, sound_class: &std::path::Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::fs;

    let Some((route, params)) = pcm.split_once(':') else {
        // A named virtual PCM selects its configured route. System Default is
        // represented separately and hardware aliases require a verified card.
        return (!matches!(pcm, "" | "default" | "sysdefault" | "hw" | "plughw"))
            .then(|| format!("cpal:alsa:{pcm}"));
    };
    let mut fields = params.split(',');
    let card = fields.next()?;
    let card = match card.strip_prefix("CARD=") {
        Some(card) => card,
        None if matches!(route, "hw" | "plughw") && !card.contains('=') => card,
        None => return None,
    };
    let card_dir = if let Ok(index) = card.parse::<u32>() {
        sound_class.join(format!("card{index}"))
    } else {
        fs::read_dir(sound_class)
            .ok()?
            .flatten()
            .find_map(|entry| {
                let path = entry.path();
                let id = fs::read_to_string(path.join("id")).ok()?;
                (id.trim() == card).then_some(path)
            })?
    };
    let location = fs::canonicalize(card_dir.join("device")).ok()?;
    let modalias = fs::read_to_string(location.join("modalias")).ok()?;
    let modalias = modalias.trim();
    if modalias.is_empty() {
        return None;
    }
    let mut identity = Sha256::new();
    identity.update(location.as_os_str().as_encoded_bytes());
    identity.update([0]);
    identity.update(modalias);
    // A USB device without a serial is identified by its model and port.
    if modalias.starts_with("usb:")
        && let Ok(serial) = fs::read_to_string(location.parent()?.join("serial"))
        && !serial.trim().is_empty()
    {
        identity.update([0]);
        identity.update(serial.trim());
    }
    let args = fields.collect::<Vec<_>>().join(",");
    Some(format!(
        "alsa-card:{route}:{args}:{:x}",
        identity.finalize()
    ))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink, path::Path};

    fn usb_card(root: &Path, index: u32, port: &str, serial: Option<&str>) {
        let device = root.join(port).join("usb-interface");
        fs::create_dir_all(&device).unwrap();
        fs::write(device.join("modalias"), "usb:v123p456\n").unwrap();
        if let Some(serial) = serial {
            fs::write(device.parent().unwrap().join("serial"), serial).unwrap();
        }
        let card = root.join(format!("card{index}"));
        fs::create_dir(&card).unwrap();
        fs::write(card.join("id"), "USB\n").unwrap();
        symlink(device, card.join("device")).unwrap();
    }

    #[test]
    fn alsa_card_identity_survives_card_renumbering_and_rejects_a_replacement() {
        let sysfs = tempfile::tempdir().unwrap();
        let root = sysfs.path();
        usb_card(root, 1, "usb-port-1", Some("first unit serial"));
        let saved = alsa_id("plughw:CARD=1,DEV=0", root).unwrap();
        assert_eq!(
            alsa_id("plughw:CARD=USB,DEV=0", root).as_ref(),
            Some(&saved)
        );
        assert!(!saved.contains("first unit serial"));

        fs::rename(root.join("card1"), root.join("card3")).unwrap();
        usb_card(root, 1, "usb-port-2", Some("second unit serial"));
        assert_eq!(alsa_id("plughw:CARD=3,DEV=0", root).as_ref(), Some(&saved));
        assert_ne!(alsa_id("plughw:CARD=1,DEV=0", root).as_ref(), Some(&saved));
        fs::write(root.join("usb-port-1/serial"), "another unit, same port").unwrap();
        assert_ne!(alsa_id("plughw:CARD=3,DEV=0", root).as_ref(), Some(&saved));
    }

    #[test]
    fn alsa_hardware_routes_require_identity_and_virtual_routes_remain_selectable() {
        let sysfs = tempfile::tempdir().unwrap();
        let root = sysfs.path();
        usb_card(root, 0, "usb-port", None);
        for route in [
            "hw:CARD=Unknown,DEV=0",
            "plughw:1,0",
            "sysdefault:CARD=1",
            "hw:CARD=1,DEV=0",
            "default",
        ] {
            assert_eq!(alsa_id(route, root), None, "{route}");
        }
        let port_id = alsa_id("hw:CARD=0,DEV=0", root).unwrap();
        usb_card(root, 1, "usb-port-2", None);
        assert_ne!(alsa_id("hw:CARD=1,DEV=0", root).as_ref(), Some(&port_id));
        assert_eq!(alsa_id("pulse", root).as_deref(), Some("cpal:alsa:pulse"));
    }
}
