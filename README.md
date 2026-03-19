<p align="center">
  <img src="renderer/assets/zano-logo.png" alt="Zano Nova" width="96" />
</p>

<h1 align="center">Zano Nova</h1>

<p align="center">
  <strong>Zano Without the Blockchain Wait.</strong><br>
  A lightweight desktop wallet that connects to a remote daemon — no local sync required.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square" alt="Platforms" />
  <img src="https://img.shields.io/badge/electron-41-47848f?style=flat-square&logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/license-ISC-green?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/version-1.0.2-orange?style=flat-square" alt="Version" />
</p>

---

## How It Works

Zano Nova runs the official `simplewallet` binary in **Wallet RPC mode** and proxies commands through a local JSON-RPC interface. Your keys never leave your machine. The wallet connects to a remote `zanod` node so you can send, receive, and manage ZANO without downloading the full blockchain.

```
[ Zano Nova UI ]  <-->  [ simplewallet RPC ]  <-->  [ Remote zanod node ]
```

---

## Quick Start

```bash
git clone https://github.com/your-org/ZanoNovaWallet.git
cd ZanoNovaWallet
npm install
npm run dev
```

> `npm run dev` automatically downloads and stages the simplewallet binary on first run.

---

## Features

| | |
|---|---|
| **Instant Setup** | No blockchain download — connect to a remote node and go |
| **Create & Restore** | Generate new wallets or restore from a 24-26 word seed phrase |
| **Send & Receive** | Transfer ZANO with built-in address validation and QR codes |
| **Privacy First** | All transfers use `mixin=15`, `hide_receiver=true` by default |
| **Cross-Platform** | Windows (installer + portable), macOS (DMG + ZIP), Linux (AppImage) |
| **Dark Glass UI** | Premium dark theme with glass morphism, Outfit + JetBrains Mono |
| **Sound Feedback** | Audio cues for startup, send, and receive events |
| **Seed Backup** | View and copy your seed phrase securely with a guarded flow |
| **Splash Screen** | Instant visual feedback on portable exe startup |

---

## Architecture

```
main/                 Electron main process
  main.js             App lifecycle, splash screen
  config.js           Persistent config, path defaults
  preload.js          Secure IPC bridge (window.zano)
  ipc.js              All IPC handlers
  simplewallet.js     Binary lifecycle, RPC client

renderer/             Vanilla JS frontend (no framework)
  index.html          Single-page app with dialogs
  app.js              Bootstrap, event wiring
  styles.css          Glass morphism dark theme
  splash.html         Startup splash screen
  lib/                Modules: wallet, send, seed, state, currency, audio, views

scripts/              Build tooling
  run-dev.js          Dev server with auto-prepare + hot restart
  run-builder.js      Unified build orchestrator
  prepare-*.js        Platform binary downloaders

build/config/         Electron Builder configs (base + per-platform)
```

---

## Building

### Development

```bash
npm run dev          # Auto-restart on changes, stages simplewallet if missing
npm start            # One-shot launch (no watch)
```

### Production

```bash
# Full distributables (installer + portable / dmg + zip / AppImage)
npm run dist:win
npm run dist:mac
npm run dist:linux

# Quick unpacked build for testing
npm run pack:win
npm run pack:mac
```

Output goes to `dist/`.

### Environment Overrides

| Variable | Effect |
|----------|--------|
| `WIN_TARGET=nsis` | Override Windows build targets |
| `MAC_TARGET=dmg` | Override macOS build targets |
| `LINUX_TARGET=AppImage` | Override Linux build targets |
| `BUILD_MAC_INTEL=1` | Also build x64 on Apple Silicon |

---

## Network Configuration

By default, Zano Nova connects to a public mainnet node:

```
Daemon: 64.111.93.25:10500
RPC:    127.0.0.1:12233
```

For production use, point **Settings > Daemon address** at your own `zanod` instance.

---

## Simplewallet Binaries

Binaries are **auto-downloaded and staged** during build and dev:

| Platform | Staging Path | Prepare Script |
|----------|-------------|----------------|
| Windows | `build/vendor/simplewallet-win/` | `scripts/prepare-simplewallet.js` |
| macOS | `build/vendor/zano-macos/` | `scripts/prepare-zano-macos.js` |
| Linux | `build/vendor/simplewallet-linux/` | Manual staging |

You can also set a custom binary path in **Settings** within the app.

Official upstream:
- [Zano Wallet Docs](https://docs.zano.org/docs/use/wallets/overview)
- [Zano Releases](https://github.com/hyle-team/zano/releases)

---

## App Icon

The icon is generated from `renderer/assets/zano-logo.png`:

```bash
npm run build-icon    # Writes assets/icon.ico + assets/icon.png
```

This runs automatically before every build. Re-run manually if you change the logo.

---

## Protocol Notes

| Constant | Value |
|----------|-------|
| 1 ZANO | 10^12 atomic units |
| Transaction fee | 0.01 ZANO (burned) |
| Default mixin | 15 |
| Confirmations | 10 for finality |
| Refresh interval | 15 seconds |

---

## Scripts Reference

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server with hot reload + auto-prepare |
| `npm start` | Launch Electron (no watch) |
| `npm run dist` | Build for current platform |
| `npm run dist:win` | Windows: NSIS installer + portable exe |
| `npm run dist:mac` | macOS: DMG + ZIP |
| `npm run dist:linux` | Linux: AppImage |
| `npm run pack:win` | Quick unpacked Windows build |
| `npm run build-icon` | Regenerate app icons |
| `npm run bump` | Patch version bump |

---

## License

ISC
