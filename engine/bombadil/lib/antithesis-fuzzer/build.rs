fn main() {
    // Windows: no libvoidstar (Antithesis runs Linux); lib.rs uses no-op stubs.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        return;
    }
    cc::Build::new()
        .file("src/libvoidstar_shim.c")
        .opt_level(3)
        .warnings(true)
        .warnings_into_errors(true)
        .flag("-Wextra")
        .compile("libvoidstar_shim");
    println!("cargo::rerun-if-changed=src/libvoidstar_shim.c");
}
