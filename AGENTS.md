# Zano Nova Wallet — Agent Guide

## What This Is

Lightweight Electron wallet that spawns the official Zano `simplewallet` binary and talks to a remote daemon over JSON-RPC. No local blockchain sync. Vanilla JS renderer (no framework). Context isolation enabled; all IPC through `window.zano.*`.

---

## Project Layout

```
main/                    Electron main process
  main.js                Window creation, app lifecycle
  config.js              Config read/write, path defaults, migration from old app name
  preload.js             Secure IPC bridge → window.zano
  ipc.js                 All IPC handlers (~320 lines)
  simplewallet.js        Binary resolution, spawn lifecycle, JSON-RPC client

renderer/                Frontend (single HTML page, ES modules)
  index.html             All views + dialogs in one file
  app.js                 Bootstrap, event wiring, main flows (~570 lines)
  styles.css             Glass morphism dark theme, Outfit + JetBrains Mono
  lib/
    wallet.js            Balance/history rendering, RPC helpers, settings dialogs
    views.js             View switching, status dot, uiBusy, tooltips
    state.js             Mutable state object + session password (private closure)
    send.js              Transfer RPC flow + validation
    seed.js              Seed extraction (regex), display, backup flow
    currency.js          BigInt atomic ↔ ZANO string conversions
    constants.js         Protocol constants (FEE, MIXIN, ASSET_ID, etc.)
    audio.js             Sound preload/play (startup, send, receive)
    dom.js               $(id), setText, appendLog helpers
    logger.js            Tagged console logger with color

scripts/
  run-dev.js             Dev launcher: auto-prepares simplewallet, kills stale processes, runs electronmon
  run-builder.js         Unified build orchestrator (pack/dist, per-platform)
  prepare-simplewallet.js   Downloads Windows ZIP, stages .exe + .dll
  prepare-zano-macos.js     Downloads macOS DMG, mounts, stages binaries + boost_libs
  build-icon.js          Generates icon.ico + icon.png from zano-logo.png

build/
  config/
    electron-builder.base.json   Shared: appId, files, output dir
    electron-builder.win.json    Targets: nsis + portable; extra resources: simplewallet-win/
    electron-builder.mac.json    Targets: dmg + zip; extra resources: zano-macos/
    electron-builder.linux.json  Targets: AppImage
  vendor/                        Staging dirs for platform binaries (gitignored)
    simplewallet-win/            .exe + .dll
    zano-macos/Contents/         MacOS/ + Frameworks/boost_libs/
    simplewallet-linux/          ELF binary + .so
```

---

## Key Flows

### Wallet Create
Welcome → name/password/location → `wallet:generate` (spawns simplewallet `--generate-new-wallet`, writes password 2x) → seed backup view → `walletShowSeed` → user confirms → `startWalletRpc` → wallet view.

### Wallet Restore
Enter seed (24-26 words) + optional passphrase + password → `wallet:restore` (spawns `--restore-wallet`, writes password 2x + seed + passphrase) → auto-starts RPC → wallet view.

### Wallet Unlock (returning user)
Unlock overlay → password → `startWalletRpc(password)` → polls RPC readiness (12s timeout) → refresh balance/history → wallet view.

### Send
Validate address via `split_integrated_address` → preflight balance check → `transfer` RPC (mixin=15, hide_receiver=true, fee=0.01 ZANO) → show tx result.

### View Seed
Warning dialog (checkbox) → `walletShowSeed` (spawns `--command=show_seed`, writes password + empty seed protection 2x) → regex extract 24-26 words → display dialog.

---

## IPC Channels

| Channel | Purpose |
|---------|---------|
| `app:getPaths` | userData, walletsDir, walletPath |
| `config:get` / `config:set` | Config CRUD |
| `wallet:generate` / `wallet:restore` / `wallet:showSeed` | One-shot simplewallet spawns |
| `wallet:rpc` | JSON-RPC proxy to running simplewallet |
| `wallet:qr` | QR code data URL generation |
| `wallet:fileExists` / `wallet:suggestNewWalletPath` | File helpers |
| `simplewallet:start` / `stop` / `state` / `resolveExe` | Lifecycle management |
| `dialog:openFile` / `dialog:saveWallet` | Native file pickers |

---

## State Management

All mutable renderer state lives in `renderer/lib/state.js`:
- `state.currentWalletFile` — the opened wallet path
- `state.lastZanoUnlockedAtomic` / `lastZanoTotalAtomic` — BigInt balances
- Session password — **private closure**, only via `getSessionPassword()` / `setSessionPassword()`; never persisted

Status broadcasts from main → renderer via `onSimplewalletState()` callback.

---

## Config

Stored at `{appData}/config.json`. Defaults:
- `daemonAddress: "37.27.100.59:10500"` (public node)
- `walletRpcBindIp: "127.0.0.1"`, `walletRpcBindPort: 12233`
- `simplewalletExePath: ""` (resolved automatically unless overridden)

App data location:
- Windows: `%APPDATA%/Zano Nova/`
- macOS: `~/Library/Application Support/Zano Nova/`
- Linux: `~/.config/Zano Nova/`

Migration from old name `zano-simple-wallet` runs automatically if new paths don't exist.

---

## Platform Differences

### Windows
- Binary: `simplewallet.exe` + bundled `.dll` files
- Vendor staging: `build/vendor/simplewallet-win/`
- Spawn: exe directory prepended to `PATH` for DLL loading
- Build targets: nsis installer + portable exe
- Icon: `assets/icon.ico`
- **pack:win uses config targets** (nsis+portable), not "dir" — don't add `defaultPackTarget: "dir"`

### macOS
- Binary: `simplewallet` + `zanod` inside `Contents/MacOS/`, boost dylibs in `Contents/Frameworks/boost_libs/`
- Vendor staging: `build/vendor/zano-macos/Contents/`
- chmod 755 required on all binaries
- Build targets: dmg + zip
- ARM64 by default; set `BUILD_MAC_INTEL=1` for x64 dual build

### Linux
- Binary: `simplewallet` + `.so` files
- Vendor staging: `build/vendor/simplewallet-linux/`
- No automated prepare script — stage manually or use system binary
- Build target: AppImage

---

## Gotchas & Common Pitfalls

### Simplewallet stdin protocol
One-shot ops (`generate`, `restore`, `showSeed`) write passwords and data to stdin in a specific order, then call `stdin.end()`. The password is written **twice** for generate/restore. For `showSeed`, the order is: wallet password → seed protection password → seed protection password (confirm). Getting this wrong hangs the process.

### Binary resolution order
1. User override path (settings)
2. Bundled in packaged app (`resources/`)
3. Dev vendor dir (`build/vendor/...`)
4. Runtime copy dir (`{userData}/simplewallet-runtime/`)
5. `null` → user must locate manually via UI

### Wallet file path in seed viewing
`handleConfirmViewSeed()` resolves wallet path as: `state.currentWalletFile` → `inputWalletFile` input value → `getPaths().walletPath` fallback. The state field is the authoritative source — the others are fallbacks for edge cases.

### BigInt everywhere for amounts
1 ZANO = 10^12 atomic units. All amounts are `BigInt`. Use `currency.js` helpers. Never mix `Number` and `BigInt`. Fee is 0.01 ZANO (10^10 atomic, burned).

### RPC port reuse
If simplewallet dies without cleanup, the port stays in TIME_WAIT. `simplewallet:start` tries to connect to an existing RPC first before spawning a new process. If you see "reused existing" in logs, that's expected.

### CSS animation easing
- `--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)` — overshoots (bouncy). Used for interactive element hover. **Don't use for dialogs** — causes visible bounce.
- `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)` — smooth deceleration. Use for dialogs and view transitions.

### Electronmon on Windows
Must use `electronmon.cmd` (not bare `electronmon`). The dev script handles this. If `node_modules/.bin/electronmon.cmd` is missing, `npm install` wasn't run.

### Don't run from WSL
Running `npm run dev` from WSL uses the Linux Electron binary, which fails with `libnspr4.so` errors because WSL lacks GUI libraries. Always use a native Windows shell (PowerShell, cmd, Git Bash).

### History deduplication
`state.knownIncomeTxs` (Set) tracks seen tx hashes to avoid playing the receive sound twice. Pending txs use a composite key: `pending:{payment_id}:{timestamp}:{amounts}`.

### uiBusy pattern
Mark buttons with `data-busy-disable` attribute to auto-disable during long operations. Call `setUiBusy(true, "reason")` / `setUiBusy(false)` around async work.

### Backend button states
`setStatus()` in `views.js` disables "Start backend" when status is `running`/`starting`, and disables "Stop" when stopped. Don't add separate listeners for this.

---

## Dev Workflow

```bash
npm install              # Install deps
npm run dev              # Auto-prepares simplewallet if missing, starts electronmon
npm run dist:win         # Build Windows installer + portable
npm run dist:mac         # Build macOS dmg + zip
npm run bump             # Patch version bump (no git tag)
npm run build-icon       # Regenerate icons from logo
```

### Environment overrides
- `WIN_TARGET=nsis` — override Windows build targets
- `MAC_TARGET=dmg` — override macOS build targets
- `BUILD_MAC_INTEL=1` — include x64 build on macOS

---

## Constants Reference

```
ATOMIC_UNITS     = 10^12
ZANO_ASSET_ID    = "d6329b5b1f7c0805b3..."
FEE_ATOMIC       = 10^10 (0.01 ZANO, burned)
MIXIN            = 15
HISTORY_PAGE_SIZE = 5
CONFIRMATION_THRESHOLD = 10
AUTO_REFRESH_MS  = 15000
TOOLTIP_DELAY_MS = 3000
```
