# Resources folder (packaged app)

This folder is copied into the built app as `resources/resources/`.

**Populated automatically:** Running `npm run dist` (or `npm run prepare-simplewallet`) downloads the latest Zano Windows build and copies `simplewallet.exe` and all required `.dll` files here, so the packaged app works for users without any setup.

If you need to refresh the binaries, run `npm run prepare-simplewallet` then `npm run dist`.
