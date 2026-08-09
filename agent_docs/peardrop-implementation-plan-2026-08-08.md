# PearDrop implementation plan

## Context

PearDrop will turn the current `hello-pear-electron` checkout into a small macOS desktop demo for handing one file directly from one peer to another. Sender selects one file, keeps PearDrop open, and shares a 64-character read capability. Receiver pastes that capability, discovers sender over Hyperswarm, downloads from a read-only Hyperdrive replica, and saves verified bytes to a user-selected path.

Research is complete in `agent_docs/pear-p2p-weekend-projects-2026-08-08.md`; implementation has not started. Current repository is still un-rebranded starter code. Existing unstaged `package.json#upgrade` value and untracked research note must be preserved.

Confirmed scope:

- Convert `/Users/jeet/Desktop/playground/pear-drop` in place.
- Product name: **PearDrop**.
- macOS source-run demo; `npm run package` remains worker-resolution smoke, not distributable deliverable.
- Plain, deliberate one-screen interface; no portfolio animation pass.
- File picker only; no drag-and-drop.
- Worker-side filesystem streaming; no file bytes through renderer, Electron IPC, or Bare IPC.
- One file at a time, maximum 25 MB; sender must remain online.
- No folders, batches, history, resume, background seeding, accounts, identity, OTA UI/release, signing, installers, or availability/encryption-at-rest claims.

## Product contract

### Send

1. User chooses one regular file through Electron `dialog.showOpenDialog`.
2. Bare worker validates size, streams file into a fresh writable Hyperdrive at fixed path `/file`, and stores metadata `{ schema: 'peardrop/1', name, size }`.
3. Worker joins `drive.discoveryKey`, waits for announcement flush, and returns lowercase `b4a.toString(drive.key, 'hex')`.
4. UI displays filename, size, preparation progress, copyable read capability, and **Stop sharing**. Sender worker, drive, and swarm stay alive until stop, failure, or app exit.

### Receive

1. User pastes a capability. Parser trims outer whitespace, requires exactly 64 hexadecimal characters, decodes exactly 32 bytes, and canonicalizes lowercase.
2. Worker opens `new Hyperdrive(session, publicKey)`, requires `drive.writable === false`, joins discovery, and reads fixed `/file` entry within a bounded deadline.
3. Worker validates schema, sanitized display name, metadata size, and `entry.value.blob.byteLength`; both sizes must match and remain at most 25 MB.
4. Main process opens `dialog.showSaveDialog` with sanitized name. Only main can authorize destination path.
5. Worker streams `drive.createReadStream('/file')` into adjacent temporary output, emits throttled progress, requires received bytes to equal expected bytes, then renames temporary file to selected destination.
6. UI reports completion, received/expected bytes, output path, and **Open file**. Main allowlists completed path by request ID before calling `shell.openPath`.

Capability is public read authority, not password, identity, write key, or at-rest encryption key. Supported security claim: Hyperswarm transport is Noise-encrypted.

## Architecture

```text
sandboxed renderer
  -> window.peardrop intent interface
  -> preload Electron IPC adapter
  -> main-process drop controller
       -> open/save dialogs, clipboard, open-file allowlist
       -> fixed transfer-worker broker
  -> FramedStream JSON messages over PearRuntime/Bare.IPC
  -> transfer engine
       -> root Corestore
       -> per-transfer Corestore session + Hyperdrive + Hyperswarm
       -> bare-fs source/output streams
```

### Deep modules and seams

- **Drop controller** hides Electron dialogs, clipboard, request IDs, destination authorization, output allowlist, worker crashes, and safe event forwarding behind intent-level renderer operations.
- **Worker broker** hides `PearRuntime.run`, `FramedStream`, readiness/ack deadlines, raw stdout/stderr, pipe failure, and graceful/forced shutdown. Renderer cannot provide worker specifiers or raw bytes.
- **Transfer engine** is deepest module. Its external interface is `dispatch(command)`, `snapshot()`, event subscription, and `close()`. It hides Corestore namespaces, Hyperdrive state, discovery, replication, stream pumping, progress throttling, deadlines, cancellation, temporary files, and cleanup.
- **Protocol**, **capability**, **file policy**, and **state reducer** are pure modules shared by production callers and tests.
- Transfer engine accepts filesystem/path and swarm-factory adapters. Worker supplies `bare-fs`/`bare-path` and real Hyperswarm; Node tests supply `node:fs`/`node:path` and `hyperdht/testnet`. Two real adapters make these seams justified.

### One in-project worker

Replace `workers/main.js` stock `hello-pear-worker` wrapper with PearDrop transfer worker. OTA is excluded, so retaining a second dormant updater worker would add shallow plumbing and a second Corestore/swarm lifecycle without serving MVP.

Electron main launches only fixed `workers/main.js` with one argument: `<storage>/app-storage/peardrop-corestore`. Worker reads it at `Bare.argv[2]`, wraps `Bare.IPC` in `FramedStream`, and owns transfer resources. Remove arbitrary renderer-selected worker startup and stock update IPC/UI.

Use current Pear v3 path only: `PearRuntime.run(...)` and worker `Bare.IPC`. Do not use removed `pear run`, ambient `global.Pear`, or archived `pear-electron` APIs.

## Storage and resource lifecycle

- Root: custom `--storage` directory for demo; otherwise current platform app storage.
- PearDrop data: `<storage>/app-storage/peardrop-corestore`.
- One root Corestore remains open for worker lifetime.
- Sender creates a unique `store.namespace('send-' + requestId)` and fresh writable Hyperdrive for every share.
- Receiver creates an independent `store.session()` and opens drive by public key; receiver writability is rejected.
- Each active transfer owns one Hyperdrive, one Hyperswarm, one discovery handle, replication sockets, active streams, timers, and optional temporary output.
- Only one transfer may be active per app instance.
- Reset/stop closes active streams, swarm, drive, and transfer store session. Root Corestore closes only at worker shutdown.
- Closed shares remain as unreferenced local Corestore data; MVP has no history, deletion, compaction, or reannounce-on-restart behavior. Document that storage is persistent and not claimed encrypted at rest.

Cleanup order for cancel/failure:

1. Mark context terminal so late events cannot emit success.
2. Destroy source/drive/output streams.
3. Destroy discovery and per-transfer swarm, closing replication sockets.
4. Remove partial output.
5. Close drive and transfer store session.
6. Clear timers and emit one terminal state.

Worker shutdown stops command intake, cancels active transfer, closes root Corestore, emits `worker.closed`, and exits. Register same idempotent cleanup with `graceful-goodbye`. Main waits up to 3 seconds, then destroys pipe/worker if needed.

## IPC interfaces

### Renderer interface exposed by preload

```js
window.peardrop = {
  getSnapshot(),
  chooseAndShare(),
  receive(capability),
  cancel(requestId),
  reset(requestId),
  copyCapability(requestId),
  openReceived(requestId),
  onEvent(listener)
}
```

No renderer method accepts source path, destination path, worker specifier, raw worker frame, or arbitrary shell path. `onEvent` returns unsubscribe function.

Electron channels:

- `peardrop:get-snapshot`
- `peardrop:choose-and-share`
- `peardrop:receive`
- `peardrop:cancel`
- `peardrop:reset`
- `peardrop:copy-capability`
- `peardrop:open-received`
- `peardrop:event`

Main associates requests with originating `webContents`. Reload/destroy cancels unfinished receive and clears path authorization.

### Worker frame envelope

Every frame is UTF-8 JSON, no larger than 16 KiB:

```js
{
  v: 1,
  type: 'known.message.type',
  requestId: 'main-generated UUID',
  // exact fields allowed by type
}
```

No file buffers, Buffer JSON, unknown fields, source/destination paths in renderer events, raw upstream errors, or stack traces. Main waits 3 seconds for `command.accepted`; pipe write alone is not acceptance.

Main to worker:

- `state.get`
- `share.start { requestId, sourcePath }`
- `receive.inspect { requestId, capability }`
- `receive.start { requestId, destinationPath }`
- `transfer.cancel { requestId }`
- `transfer.reset { requestId }`
- `worker.shutdown`

Worker to main:

- `worker.ready { snapshot }`
- `command.accepted { requestId, command }`
- `state.changed { requestId, mode, state, file?, capability?, bytes?, peers? }`
- `receive.metadata { requestId, file }`
- `transfer.progress { requestId, phase, transferred, total }`
- `transfer.error { requestId, error: { code, message, retryable } }`
- `worker.closed`

Duplicate identical commands return current snapshot; conflicting command reuse returns `INVALID_STATE`. Progress is monotonic and emitted at most 10 times/second.

## Transfer states

Sender:

```text
idle -> preparing -> announcing -> sharing -> stopping -> idle
                    \-> failed -> reset -> idle
```

Receiver:

```text
idle -> discovering -> awaiting-destination -> transferring -> verifying -> completed
         \______________________________-> cancelling -> idle
         \______________________________-> failed -> reset -> idle
```

Renderer only renders authoritative state events. It does not infer P2P completion from button promises.

Deadlines:

- Worker ready: 5 seconds.
- Command acknowledgement: 3 seconds.
- Source ingest: 30 seconds.
- Sender announcement: 10 seconds.
- Receiver discovery/manifest: 15 seconds.
- Download inactivity: 20 seconds, reset on every chunk.
- Total download: 5 minutes.
- Save-dialog wait: 5 minutes.
- Cancellation cleanup: 2 seconds.
- App shutdown: 3 seconds.

All waiting Hyperdrive operations and swarm flushes race deadline and cancellation. `drive.findingPeers()` completion callback runs in `finally`. Destroy losing streams/discovery work; do not leave waiters alive.

## Error model

Worker/main normalize failures to stable codes and actionable UI text:

- `INVALID_CAPABILITY`: paste sender's 64-character PearDrop key.
- `BUSY` / `INVALID_STATE`: finish or cancel current handoff first.
- `NOT_A_FILE`: choose one regular file.
- `FILE_TOO_LARGE`: choose file no larger than 25 MB.
- `SOURCE_UNREADABLE` / `SOURCE_CHANGED`: choose source again.
- `ANNOUNCE_TIMEOUT`: network announcement failed; retry sharing.
- `SENDER_UNAVAILABLE`: keep sender online, verify key, retry.
- `REMOTE_MANIFEST_INVALID`: key does not identify supported PearDrop handoff.
- `WRITABLE_REPLICA`: receiver refused unexpected write authority.
- `DESTINATION_UNWRITABLE`: choose another output location.
- `TRANSFER_STALLED` / `TRANSFER_TIMEOUT` / `CONNECTION_LOST`: partial output removed; keep sender online and retry.
- `BYTE_MISMATCH`: received and expected bytes differ; partial output removed.
- `CANCELLED`: handoff stopped and resources cleaned.
- `WORKER_NOT_READY` / `WORKER_UNRESPONSIVE` / `WORKER_CRASHED`: restart handoff or app.
- `INTERNAL`: PearDrop stopped safely; retry after restart.

Raw errors and stacks go to local stderr only.

## File changes

### Modify

- `package.json`: rename package to `pear-drop`, product to `PearDrop`; preserve exact `upgrade`; remove `hello-pear-worker`; update `pear-runtime` range; add scripts and approved direct dependencies.
- `package-lock.json`: lock dependency changes without losing current manifest edit.
- `electron/main.js`: composition root, storage selection, fixed worker broker/controller, window lifecycle, graceful quit; remove updater and arbitrary worker IPC.
- `electron/preload.js`: expose narrow `window.peardrop` interface.
- `renderer/index.html`: one-screen Send and Receive panels, semantic live regions, progress, errors, capability, copy/stop/open/reset controls.
- `renderer/app.js`: invoke intents and render worker snapshots/events; no filesystem or network logic.
- `workers/main.js`: in-project Bare entrypoint, framed JSON dispatch, engine composition, graceful cleanup.
- `README.md`: source setup, macOS scope, architecture, limitations, exact demo and acceptance script.
- `AGENTS.md`: replace stock updater contracts with PearDrop worker/protocol/storage/test contracts.
- `agent_docs/architecture.md`: document new host/worker seam, argv, protocol, lifecycle, storage, and testnet behavior.
- `agent_docs/updates.md`: state OTA UI/worker path is outside PearDrop MVP while `pear-runtime` remains worker host.

### Create

- `electron/worker-broker.js`
- `electron/drop-controller.js`
- `lib/protocol.js`
- `lib/capability.js`
- `lib/file-policy.js`
- `lib/transfer-state.js`
- `lib/transfer-engine.js`
- `renderer/styles.css`
- `test/capability.test.js`
- `test/protocol.test.js`
- `test/transfer-state.test.js`
- `test/file-policy.test.js`
- `test/transfer-lifecycle.test.js`
- `test/integration/two-peer.test.js`
- `test/integration/worker-ipc.test.js`

### Preserve unchanged

- `package.json#upgrade` value.
- `agent_docs/pear-p2p-weekend-projects-2026-08-08.md`.
- `pear.json`, `forge.config.js`, `build/`, `flatpak/`, and release workflows.
- No `npm run make`, Pear deployment command, signing, publish, tag, or commit.

### Dependency changes requiring plan approval

Runtime dependencies, current versions verified 2026-08-08:

- `corestore@^7.12.0`
- `hyperdrive@^13.3.3`
- `hyperswarm@^4.17.0`
- `b4a@^1.8.1`
- `bare-fs@^4.8.0`
- `bare-path@^3.1.1`
- `graceful-goodbye@^1.3.3`

Development dependency:

- `hyperdht@^6.33.0` for deterministic `hyperdht/testnet` integration tests.

Continue using `framed-stream`, `paparam`, `pear-runtime`, and existing Electron/Forge tooling. Use npm only.

## Test strategy and approved seams

Use CommonJS `node:test` plus `node:assert/strict`; add no test framework. Plan approval confirms these test seams:

1. Capability parser interface.
2. Protocol validator/serializer interface.
3. State reducer interface.
4. File policy interface.
5. Transfer engine public interface.
6. Framed worker command/event interface.
7. Manual renderer-to-output user flow.

Each vertical slice follows red -> green: one failing behavior at one seam, minimum implementation, then next behavior. Do not bulk-write speculative tests or assert private collaborators.

Coverage:

- Capability: valid canonical key, whitespace, wrong length, nonhex, odd hex, non-32-byte decode.
- Protocol: versions, UUIDs, exact fields, frame limit, malformed JSON, unknown command, duplicate/conflicting request.
- State: all legal transitions, illegal transition stability, cancel/reset, one terminal event.
- File policy: regular-file/25 MB checks, fixed drive path, schema/size/blob-length validation, slash/control/NUL filename sanitation, temp path, byte underflow/overflow.
- Lifecycle: stalled read, cancel, sender interruption, timeout, partial cleanup, idempotent close, cleanup ordering observable through engine events.
- Local P2P integration: two temporary Corestores and two Hyperswarms backed by separate `hyperdht/testnet` nodes; transfer deterministic 1–2 MB fixture, assert receiver non-writable, monotonic progress, exact bytes, cleanup, then interrupt second transfer and assert no completed/partial output.
- Worker IPC: launch through `PearRuntime.run`, wait for ready, reject malformed frame, run a small path-stream smoke, request shutdown, and assert clean exit.

Scripts:

```text
npm test
npm run test:unit
npm run test:integration
npm run lint
npm run package
```

## Vertical slices and time boxes

| Elapsed | Slice | Smallest proof |
|---:|---|---|
| 0–0.5 h | Protect current edits, record baseline, rebrand runtime metadata, add scripts/dependencies. | `package.json#upgrade` and research note unchanged; baseline lint result recorded. |
| 0.5–2 h | Capability, protocol, file policy, and first state transitions using tracer-bullet TDD. | Focused tests reject bad key/frame/path and accept one valid send/receive command. |
| 2–3.5 h | Fixed broker, in-project worker, Bare path-stream/Hyperdrive spike in dev and packaged app. | Worker streams 1 MB filesystem -> Hyperdrive -> temp file, reports exact bytes, shuts down cleanly; packaged worker reaches ready. |
| 3.5–6 h | Sender vertical slice: picker -> worker -> fresh drive -> announce -> capability -> stop. | UI selects fixture, shows 64 lowercase hex key, remains sharing, then cleans up. |
| 6–10 h | Receiver vertical slice: key -> read-only drive -> discovery -> metadata -> save -> streamed output. | Two separate storage roots move 1 MB over local testnet with monotonic progress and exact bytes. Hour-10 gate. |
| 10–12.5 h | Cancellation, timeouts, interruption, normalized errors, worker crash and app shutdown. | Invalid key immediate; offline key bounded; interrupted/cancelled transfer leaves no `.part`; cleanup deadlines hold. |
| 12.5–14.5 h | Complete plain one-screen UI, copy/open/reset actions, accessibility states. | Demo completes without DevTools or terminal interpretation. |
| 14.5–18 h | Full tests, public two-instance rehearsal, docs, lint, packaged worker boot. | Tests/lint pass; source demo passes acceptance; packaged app starts worker. |

Expected source-demo total: **18 hours**. Packaged distributable remains separate **+4–8 hours**.

## Fallback gates

### File seam gate, no more than 2 hours

If Electron-selected absolute paths cannot be streamed by packaged Bare after 2 hours of focused work, stop instead of sending whole buffers through IPC. Source-only macOS may continue only if source-run worker path is proven. Otherwise present research note's **Live Markdown** fallback for explicit user approval; do not silently change product or introduce unbounded host chunks.

### Hour-10 gate

Required proof: two separate storage roots transfer 1 MB through real Corestore/Hyperdrive/Hyperswarm and intended worker seam with `received === expected`.

- If local testnet passes but public discovery fails, preserve local technical demo, stop polish, diagnose network/NAT separately, and mark public acceptance unmet.
- If worker IPC fails but direct engine integration passes, stop UI work and repair broker seam; no mocked renderer success.
- If Hyperdrive replication fails on local testnet, preserve runnable drive/read-only proofs and tests, but do not claim PearDrop acceptance.
- Any fallback cuts open-file convenience, peer count, extra polish, and packaging work first.

## Two-instance demo

Prepare fixture and storage:

```sh
mkdir -p "$HOME/.peardrop-demo"
dd if=/dev/urandom of="$HOME/.peardrop-demo/demo.bin" bs=1048576 count=5
shasum -a 256 "$HOME/.peardrop-demo/demo.bin"
```

Sender:

```sh
cd /Users/jeet/Desktop/playground/pear-drop
npm start -- --storage "$HOME/.peardrop-demo/sender"
```

Choose `$HOME/.peardrop-demo/demo.bin`, copy displayed capability, keep sender open.

Receiver:

```sh
cd /Users/jeet/Desktop/playground/pear-drop
npm start -- --storage "$HOME/.peardrop-demo/receiver"
```

Paste capability and save as `$HOME/.peardrop-demo/received-demo.bin`.

Verify independently:

```sh
shasum -a 256 \
  "$HOME/.peardrop-demo/demo.bin" \
  "$HOME/.peardrop-demo/received-demo.bin"
```

## Objective acceptance checks

1. Two instances run concurrently with separate `--storage` roots.
2. Sender accepts exactly one regular file up to 25 MB and emits exactly 64 lowercase hex characters; no path or writer secret appears.
3. Receiver is asserted non-writable, discovers sender, displays bounded discovery state, and shows monotonic progress not exceeding expected bytes.
4. Completion requires `received === expected`; UI shows usable output path and enabled **Open file**; external SHA-256 values match.
5. Invalid key fails immediately with corrective text.
6. Valid key with stopped sender fails as `SENDER_UNAVAILABLE` within 15 seconds.
7. Sender interruption produces bounded error, no success, and no `.part` file.
8. Cancel settles within 2 seconds and returns to idle.
9. Quit closes stream, discovery, swarm, drive/session, Corestore, and worker within shutdown deadline.
10. `npm test`, `npm run lint`, public source demo, and packaged-worker boot smoke pass. Any skipped or failed check is reported exactly.