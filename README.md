# Simple Zano Wallet (Windows 11)

Lightweight desktop wallet UI that runs the official `simplewallet` binary in **Wallet RPC mode** and connects it to a **remote daemon** (so you don’t download the blockchain locally).

## Prereqs

- Node.js (recent LTS recommended)
- Zano `simplewallet.exe` from official builds

## simplewallet.exe and DLLs

Builds fetch and stage `simplewallet.exe` plus required `.dll` files automatically.

- Staging path: `build/vendor/simplewallet-win/` (generated during build)
- Packaged location at runtime: `resources/` inside the app

You can still set a custom path in app Settings if you want to use a different binary.

Official builds are linked from Zano docs and releases:

- `https://docs.zano.org/docs/use/wallets/overview`
- `https://github.com/hyle-team/zano/releases`

## Default network setup (lightweight)

This app **does not run** `zanod` locally. It runs only `simplewallet` and points it at a remote daemon:

- Default daemon: `37.27.100.59:10500` (mainnet dev/public node)

For production use, point Settings → **Daemon address** at **your own** `zanod` instance.
Zano docs: `https://docs.zano.org/docs/build/rpc-api/overview`

## Run (dev)

```bash
cd ZanoNovaWallet
npm install
npm start
```

For auto-restart during Electron development:

```bash
npm run dev
```

## App icon (Windows)

The Windows .exe and installer use the Zano logo on a black background. The icon is built from `assets/logo.png`:

```bash
npm run build-icon
```

This writes `assets/icon.ico`. Run it after changing the logo; then run `npm run dist` so the new icon is included.

## Build output by platform

Electron Builder configs are split by platform:

- `build/config/electron-builder.base.json` (shared config)
- `build/config/electron-builder.win.json`
- `build/config/electron-builder.mac.json`
- `build/config/electron-builder.linux.json`

Windows (with auto-staged simplewallet + DLLs):

```bash
npm run dist:win
```

macOS:

```bash
npm run dist:mac
```

macOS staging details:

- `scripts/prepare-zano-macos.js` downloads the pinned upstream DMG
- `simplewallet` + `zanod` are staged into `build/vendor/zano-macos/`
- electron-builder includes those staged binaries for macOS targets

Linux:

```bash
npm run dist:linux
```

Unified builder wrapper:

- `npm run pack` builds the current OS into an unpacked `dir` target
- `npm run dist` builds the current OS using that platform's configured targets
- `npm run dist -- --publish=always` passes extra flags straight through to `electron-builder`
- `.env` can override targets with `MAC_TARGET`, `WIN_TARGET`, `LINUX_TARGET`
- On Apple Silicon, mac builds default to `--arm64`; add `BUILD_MAC_INTEL=1` to also build `x64`

Windows staging details:

- `scripts/prepare-simplewallet.js` downloads the pinned upstream ZIP
- `simplewallet.exe` + `.dll` files are staged into `build/vendor/simplewallet-win/`
- electron-builder includes that staged payload only for Windows targets

Output goes to `dist/`.

## Notes

- Amounts are in atomic units in RPC: 1 ZANO = 10^12
- Fee is flat 0.01 ZANO (burned)
- Treat incoming funds as final after 10 confirmations

