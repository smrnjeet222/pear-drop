# Update behavior

> Read this before touching `package.json#upgrade`, update behavior, or release assumptions.
> PearDrop does not implement application updates.

## Current contract

1. `pear-runtime` hosts the fixed PearDrop transfer worker only.
2. `workers/main.js` contains transfer logic, not `hello-pear-worker` or updater logic.
3. Electron exposes no apply, relaunch, update-status, arbitrary-worker, or raw-worker IPC.
4. The renderer contains no updater state or controls.
5. The hidden `--no-updates` flag is accepted only because the existing `npm start` script
   passes it; the flag has no runtime effect.

Keep the exact `package.json#upgrade` value unchanged. It remains preserved release metadata;
PearDrop does not read it or claim OTA support.

## Out of scope

Do not add an updater worker, OTA renderer flow, background update checks, staged deployment,
or apply/relaunch behavior under the PearDrop MVP. Treat any such work as a separate product
change requiring an approved plan and a fresh review of packaging, signing, platform stores,
and release metadata.

Preserve `pear.json`, `forge.config.js`, `build/`, `flatpak/`, and release workflows while
working on transfer features. Their presence does not make the current PearDrop demo a signed,
published, or supported distributable.
