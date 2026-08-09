# PearDrop

Send one file directly to another PearDrop instance with a copyable read capability.
PearDrop is a macOS source-run demo built with Electron, a Bare worker, Hyperdrive, and
Hyperswarm.

## Run the demo

1. Install dependencies.

   ```sh
   npm run install:all
   ```

2. Start PearDrop.

   ```sh
   npm start
   ```

3. Choose **Send** or **Receive** in the one-screen app.

The sender must keep PearDrop open until the receiver finishes. Each handoff supports one
regular file up to 25 MB.

## Transfer between two instances

1. Create a fixture and two storage roots.

   ```sh
   mkdir -p "$HOME/.peardrop-demo"
   dd if=/dev/urandom of="$HOME/.peardrop-demo/demo.bin" bs=1048576 count=5
   shasum -a 256 "$HOME/.peardrop-demo/demo.bin"
   ```

2. Start the sender.

   ```sh
   npm start -- --storage "$HOME/.peardrop-demo/sender"
   ```

3. Choose `demo.bin`, copy the 64-character read capability, and keep the sender open.

4. Start the receiver from a second terminal.

   ```sh
   npm start -- --storage "$HOME/.peardrop-demo/receiver"
   ```

5. Paste the capability, choose `$HOME/.peardrop-demo/received-demo.bin`, then compare the
   files.

   ```sh
   shasum -a 256 \
     "$HOME/.peardrop-demo/demo.bin" \
     "$HOME/.peardrop-demo/received-demo.bin"
   ```

## How it works

1. Electron authorizes the source file with a native open dialog.
2. The fixed Bare worker streams the file into a fresh writable Hyperdrive and announces it
   over Hyperswarm.
3. The sender shares the drive's lowercase 64-character public key as read capability.
4. The receiver opens a read-only replica, validates the manifest, and asks Electron for a
   save destination.
5. The worker streams to an adjacent temporary file, verifies the byte count, and renames it
   into place.

The sandboxed renderer calls only intent-level methods on `window.peardrop`. File bytes,
source paths, destination paths, worker specifiers, raw frames, and stack traces do not pass
through the renderer API. A completed destination path is displayed only after main has
allowlisted it for that request, which also gates **Show in folder**. PearDrop reveals received
files in the file manager instead of launching remote-controlled content.

## Security claims

- Hyperswarm transport is Noise-encrypted.
- The capability grants public read access while the sender is sharing; it is not a password,
  identity, write key, or encryption-at-rest key.
- The receiver rejects writable replicas and invalid PearDrop manifests.
- Electron keeps Node integration off, context isolation on, and the renderer sandbox on.
- Transfer data persists under `<storage>/app-storage/peardrop-corestore`; PearDrop does not
  claim encryption at rest or automatic cleanup of old share data.

## Current scope

Included:

- One file at a time, up to 25 MB
- File picker and save dialog
- Copy, stop, cancel, reset, progress, completion path, and show-in-folder actions
- Bounded discovery, transfer, cancellation, and shutdown deadlines
- Separate storage roots for a two-instance demo

Not included:

- Folders, batches, history, resume, or background sharing
- Drag-and-drop, accounts, identity, or availability guarantees
- OTA update UI or updater worker
- Signing, installers, publishing, or store delivery
- A packaged distributable acceptance claim

`npm run package` creates a packaged app only to locate, boot, and gracefully stop its Bare
worker. It is not a supported distributable deliverable.

## Checks

Run each check from the repository root.

```sh
npm run test:unit
npm run test:integration
npm run lint
npm run package
```

`npm test` runs the unit and integration suites together. Integration tests use local
`hyperdht/testnet` nodes; they do not prove public-DHT reachability or NAT traversal.
