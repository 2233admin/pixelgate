# engine

`bombadil/` is [Bombadil](https://github.com/antithesishq/bombadil), property-based testing
for web UIs, vendored with `git subtree` at upstream commit
`078afdc01c4a0d137ffa6ab6f57d2ae4ec80881e` (MIT, Copyright (c) 2024 Antithesis; see
`bombadil/LICENCE`). `pixelgate explore` runs its CLI as the exploration engine against a
Chromium that pixelgate starts with Playwright (`bombadil browser test-external`).

## Local changes

On top of upstream, kept small so `git subtree pull` stays easy:

- `lib/antithesis-fuzzer`: on Windows, skip the C shim (it `dlopen`s Antithesis'
  `libvoidstar`, which does not exist there) and make its three FFI calls no-ops.
- `lib/cdp/src/conn.rs`, `lib/cdp/Cargo.toml`: on Windows, poll the CDP websocket through
  a `mio::net::TcpStream` over a clone of the socket instead of a Unix `SourceFd`, and
  re-register before every poll (mio re-arms a Windows socket only after its own I/O call
  returns `WouldBlock`, and tungstenite reads through the std stream).
- `lib/bombadil-cli/build.rs`: ship the placeholder inspect page when `trunk` is not
  installed; link with a 16 MB main-thread stack on Windows (MSVC gives 1 MB, the engine
  needs more).
- `rust-toolchain.toml`: pins the Rust version the release binaries are built with.

Outside the subtree, `about.toml` and `about.hbs` configure
[cargo-about](https://github.com/EmbarkStudios/cargo-about), which writes the
`THIRD_PARTY_LICENSES.html` attached to each release.

## Distribution

`.github/workflows/release.yml` builds the binaries (through `engine.yml`, without the build
cache), pins their sha256 in the npm package's `engine-manifest.json`, attests them and
attaches them to the GitHub release as `pixelgate-engine-<target>`. `pixelgate explore`
downloads the one for its platform on first use and checks it against the manifest
(`src/engine.ts`).

## Build

```bash
cd engine/bombadil
cargo build --release -p bombadil-cli --no-default-features --locked
```

`--no-default-features` leaves out the terminal driver (it needs a PTY and libghostty-vt)
and is what pixelgate ships. The binary is `target/release/bombadil` (`.exe` on Windows).
`.github/workflows/engine.yml` builds it for Windows, Linux and macOS.

## Update upstream

```bash
git subtree pull --prefix=engine/bombadil https://github.com/antithesishq/bombadil.git main --squash
```

Then check the local changes above still apply, update the commit at the top of this file
and run the explore e2e test.
