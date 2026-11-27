fn main() {
    println!("cargo::rerun-if-changed=build.rs");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // The WebRTC dependency's linker flags do not reach the app's final link.
        println!("cargo::rustc-link-arg-bin=falky-desktop=-Wl,-ObjC");
    }
}
