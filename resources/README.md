# Resources folder (packaged app)

This folder is copied into the built app as `resources/resources/`.

This folder is for app-level resources (audio, docs, static assets).

Windows wallet binaries are staged outside this folder during Windows builds:

- staged path: `build/vendor/simplewallet-win/`
- build command: `npm run dist:win`

The staged payload is injected into packaged app resources only for platform-specific targets.
