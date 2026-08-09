# PearDrop architecture (`electron/`, `renderer/`, `workers/`)

> Read this before editing Electron, renderer, worker composition, IPC, storage, or startup.
> Keep only non-obvious, code-verified facts here; source remains authoritative.

## Process boundary

```text
sandboxed renderer
  -> window.peardrop intents
  -> Electron IPC
  -> DropController
       -> native dialogs, clipboard, completed-path allowlist, shell.showItemInFolder
       -> WorkerBroker
  -> FramedStream JSON over PearRuntime/Bare.IPC
  -> TransferEngine
       -> Corestore session, Hyperdrive, Hyperswarm, bare-fs streams
```

The renderer does not start workers or select worker specifiers. `electron/main.js` resolves
`workers/main.js` itself and launches exactly that file through
`PearRuntime.run(entrypoint, [workerStorage])`.

## Startup and storage

1. `paparam` accepts `--storage <dir>`, the development-compatible no-op `--no-updates`, and
   Electron's hidden `--no-sandbox` flag. Unknown arguments still fail parsing.
2. A custom `--storage` path becomes Electron `userData`; otherwise Electron's current
   platform `userData` path is the storage root.
3. Main passes `<storage>/app-storage/peardrop-corestore` as the worker's only app argument.
4. Bare reads that path from `Bare.argv[2]` and keeps one root Corestore open until shutdown.
5. Separate `--storage` roots permit two source instances without sharing a Corestore.

The app does not take a single-instance lock. Never run two instances against the same
storage root.

## Electron ownership

`DropController` associates every request with the originating `webContents`. Only main may:

- authorize a source through `dialog.showOpenDialog({ properties: ['openFile'] })`
- authorize a destination through `dialog.showSaveDialog({ defaultPath: safeName })`
- copy an active sender capability
- allowlist a completed destination by request ID and owner
- reveal that allowlisted destination with `shell.showItemInFolder` without launching it

Navigation or renderer destruction cancels unfinished receive work and clears output
authorization. Closing the last window quits the app, so active sharing cannot remain hidden
without a controllable renderer.

## Preload surface

`electron/preload.js` exposes only `window.peardrop`:

```js
{
  ;(getSnapshot, chooseAndShare, receive, cancel, reset, copyCapability, openReceived, onEvent)
}
```

Request-taking methods validate UUID shape in preload. `receive` accepts a string only.
`onEvent` returns an unsubscribe function. The BrowserWindow keeps renderer sandboxing and
context isolation enabled and Node integration disabled.

No preload method accepts a source path, destination path, shell path, worker specifier, raw
frame, or bytes. Main may return an allowlisted output path only after a completed receive.

## Host/worker protocol

`lib/protocol.js` validates every frame before dispatch. Frames are exact-schema UTF-8 JSON,
protocol version 1, and at most 16 KiB.

Main commands:

- `state.get`
- `share.start { sourcePath }`
- `receive.inspect { capability }`
- `receive.start { destinationPath }`
- `transfer.cancel`
- `transfer.reset`
- `worker.shutdown`

Worker events:

- `worker.ready { snapshot }`
- `command.accepted { command }`
- `state.changed { mode, state, file?, capability?, bytes?, peers? }`
- `receive.metadata { file }`
- `transfer.progress { phase, transferred, total }`
- `transfer.error { error }`
- `worker.closed`

Pipe write is not command acceptance. `WorkerBroker` waits up to three seconds for the
matching `command.accepted`, and worker readiness is bounded to five seconds. Raw worker
stdout/stderr stays in main's local logs and is not forwarded to the renderer.

## Transfer resources

A send owns a unique `store.namespace('send-' + requestId)`, writable Hyperdrive, server-side
Hyperswarm join, discovery handle, replication connections, and source/drive streams. A
receive owns an independent `store.session()`, a public-key Hyperdrive that must be
read-only, a client-side join, and drive/output streams.

Cancel and failure cleanup follows this order:

1. Mark the transfer terminal and destroy active streams.
2. Destroy discovery and swarm connections.
3. Remove partial output when present.
4. Close the drive and transfer store session.
5. Clear timers and emit one terminal state.

The root Corestore closes only at worker shutdown. `WorkerBroker` asks for `worker.shutdown`,
waits for `worker.closed` within the remaining three-second budget, then destroys the pipe or
raw worker if needed. Main shares one idempotent, three-second shutdown promise between normal
`before-quit` handling and each Windows window's `query-session-end` handler; Windows session
end delays briefly for cleanup and then uses `app.exit(0)`. The worker also registers
idempotent cleanup with `graceful-goodbye`.

## Renderer state

The renderer displays authoritative snapshots and events. It does not infer network or file
completion from an IPC promise. A promise confirms command acceptance only.

- Send: `idle -> preparing -> announcing -> sharing -> stopping -> idle`
- Receive: `idle -> discovering -> awaiting-destination -> transferring -> verifying -> completed`
- Either flow may enter `failed`; receive cancellation passes through `cancelling`.

Progress comes only from `transfer.progress` or the latest authoritative byte snapshot.
Completed output text and **Show in folder** appear only when main includes the authorized path.

## Integration tests

`test/integration/two-peer.test.js` uses separate temporary Corestores and separate
`hyperdht/testnet` nodes. This proves local Hyperdrive/Hyperswarm replication, read-only
receiver behavior, byte equality, progress monotonicity, interruption handling, and partial
cleanup. It does not prove public-DHT reachability or NAT traversal.

`test/integration/worker-ipc.test.js` launches the real fixed worker through `PearRuntime.run`,
waits for readiness, exercises framed command handling, and checks graceful shutdown.
