# AGENTS.md

Build PearDrop as a narrow macOS source-run demo for sending one file directly between two
instances. Keep the approved implementation contract in
[`agent_docs/peardrop-implementation-plan-2026-08-08.md`](agent_docs/peardrop-implementation-plan-2026-08-08.md).

Use npm only. `pnpm` breaks `forge.config.js` because that file relies on hoisted
`pear-link`.

## Commands

```sh
npm start                            # source app with default storage
npm start -- --storage <dir>         # source app with isolated storage
npm run test:unit                    # pure and lifecycle tests
npm run test:integration             # local testnet and worker IPC tests
npm test                             # all Node tests
npm run lint                         # prettier --check . && lunte
npm run package                      # packaged worker-resolution smoke
```

Do not run `npm run make` for normal PearDrop work. Packaging is a boot smoke, not a
supported distributable claim.

## Composition contracts

1. `electron/main.js` launches only the fixed `workers/main.js` entrypoint through
   `PearRuntime.run(entrypoint, [workerStorage])`.
2. The worker reads its sole app argument from `Bare.argv[2]` as
   `<storage>/app-storage/peardrop-corestore`.
3. Electron owns open/save dialogs, clipboard writes, completed-path authorization, and
   `shell.showItemInFolder`. Received files are never launched directly.
4. The Bare worker owns Corestore, Hyperdrive, Hyperswarm, filesystem streams, temporary
   output, deadlines, and cleanup.
5. Window close and app quit stop the controller, request graceful worker shutdown, and force
   pipe teardown after the broker's three-second deadline. On Windows, each window's
   `query-session-end` event uses the same bounded shutdown before `app.exit(0)`.

Do not add renderer-selected worker specifiers, raw worker channels, updater channels, or a
second worker.

## Renderer boundary

Expose only this preload interface:

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

Keep `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`. Do not expose
file bytes, source paths, destination paths before completion, arbitrary shell paths, raw
frames, stdout/stderr, package metadata, or Node primitives. The renderer may display the
allowlisted completed output path returned by main.

## Transfer protocol

Every host/worker frame is exact-schema UTF-8 JSON no larger than 16 KiB:

```js
{ v: 1, type: 'known.message.type', requestId: 'main-generated UUID' }
```

Main sends `state.get`, `share.start`, `receive.inspect`, `receive.start`,
`transfer.cancel`, `transfer.reset`, and `worker.shutdown`. The worker emits `worker.ready`,
`command.accepted`, `state.changed`, `receive.metadata`, `transfer.progress`,
`transfer.error`, and `worker.closed`.

Keep progress monotonic and at most 10 events per second. Normalize errors to public codes;
log raw errors only to local stderr. Never put buffers, stack traces, writer secrets, or
unknown fields in frames.

## Storage and lifecycle

- Keep one root Corestore open for the worker lifetime.
- Create a unique writable namespace for each send and an independent read-only session for
  each receive.
- Allow one active transfer per app instance.
- Stop streams before discovery/swarm, partial output, drive/session, and timers.
- Keep old send data persistent and unreferenced; there is no history, compaction, deletion,
  or encryption-at-rest claim.

## Change boundaries

Always:

- Update descriptive docs when implementation facts change.
- Run unit tests, integration tests, and lint.
- Run `npm run package` after worker or worker-resolution changes.
- Preserve the exact `package.json#upgrade` value.
- Report skipped checks and blockers exactly.

Ask before:

- Editing `pear.json`, `forge.config.js`, `build/`, `flatpak/`, release workflows, identity,
  signing, or dependency versions
- Changing protocol fields, storage layout, transfer limits, or public security claims

Never:

- Commit, push, publish, tag, stage/provision/multisig, sign, or make installers unless the
  user explicitly requests that action
- Add drag-and-drop, folders, batches, resume, history, background sharing, accounts, OTA UI,
  or updater behavior without a new approved plan
- Enable asar or Node integration
- Add Claude or Anthropic attribution

## Topic docs

1. Read [`agent_docs/architecture.md`](agent_docs/architecture.md) before editing Electron,
   renderer, worker composition, IPC, storage, or startup.
2. Read [`agent_docs/updates.md`](agent_docs/updates.md) before touching the upgrade field,
   update behavior, or release assumptions.
3. Read [`agent_docs/packaging.md`](agent_docs/packaging.md) before editing packaging or
   platform metadata.
4. Read [`agent_docs/releases.md`](agent_docs/releases.md) before editing workflows or release
   metadata.
