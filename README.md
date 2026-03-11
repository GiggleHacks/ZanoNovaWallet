# Simple Zano Wallet (Windows 11)

Lightweight desktop wallet UI that runs the official `simplewallet` binary in **Wallet RPC mode** and connects it to a **remote daemon** (so you don’t download the blockchain locally).

## Prereqs

- Node.js (recent LTS recommended)
- Zano `simplewallet.exe` from official builds

## Put `simplewallet.exe` in place

Place `simplewallet.exe` here:

- `zano-simple-wallet/resources/simplewallet.exe`

Or set a custom path in the app Settings.

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
cd zano-simple-wallet
npm install
npm start
```

## Build installer (Windows)

```bash
npm run dist
```

Output goes to `zano-simple-wallet/dist/`.

## Notes

- Amounts are in atomic units in RPC: 1 ZANO = 10^12
- Fee is flat 0.01 ZANO (burned)
- Treat incoming funds as final after 10 confirmations

