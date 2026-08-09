# Build DirectDrop: the strongest Pear/P2P weekend project

**Decision:** build **#1 DirectDrop**, a two-device file handoff with a small Electron UI and a Bare P2P worker. It wins because the 30-second demo is obvious, the data path is genuinely peer-to-peer, and the MVP needs only one writer, one read-only replica, and APIs already shown together in the official Hyperdrive/Hyperswarm documentation.

**Verified:** 2026-08-08.

**Method and source scope:** checked the current Pear release overview, API/reference pages, how-to guides, official starter repositories, package READMEs/source, repository archive flags, and repository activity metadata. Sources are limited to `docs.pears.com`, `pears.com`, and `github.com/holepunchto`. Package versions below are the versions identified by the official Pear documentation, not versions inferred from a registry or package mirror. Repository activity is reported only as a maintenance signal; it is not treated as a stability guarantee.

## Decision table

| Rank | Project | Primary showcase | Weekend estimate | Main reason to choose it |
|---:|---|---|---:|---|
| **1** | **DirectDrop** | Hyperdrive replication over Hyperswarm | **16–19 hours** | Best demo-to-risk ratio |
| **2** | **Live Markdown Broadcast** | Hypercore append-only live replication | **13–16 hours** | Smallest credible real-time data model |
| **3** | **Pocket Field Guide** | Sparse Hyperbee lookups from a read-only replica | **14–17 hours** | Shows useful partial replication, not just chat |
| **4** | **Room Pulse** | Direct encrypted Hyperswarm sockets | **12–14 hours** | Fastest build; no replicated database |
| **5** | **Mergeboard** | Autobase multiwriter convergence and blind pairing | **18–20 hours** | Highest technical signal, highest weekend risk |

### Estimation boundary

Estimates are for **one engineer** and assume Pear and Node are installed, the project starts from an official current template, two local instances are available, the UI is plain HTML/CSS, and the demo is run from source. They include roughly **2 hours** for a two-instance test pass. They exclude code signing, app-store packaging, polished OTA release operations, mobile support, accessibility certification, and hostile-network security review. Add **4–8 hours** for a distributable desktop build and update-path rehearsal.

## Current API and status guardrails

1. **Use the Pear v3 model.** Pear v3 removed the `pear run` CLI command and ambient `global.Pear`; the current model embeds `pear-runtime`, while the CLI focuses on installation and deployment. `pear stage`, `pear provision`, and `pear multisig` are the current release flow; complete `pear://<key>` links replace aliases ([Pear v3 release overview](https://docs.pears.com/release-overview/), [migration guide](https://docs.pears.com/how-to/operate-an-app/migration/)).

2. **Do not confuse two similarly named interfaces.** The removed command is **`pear run`**. The current library still exposes **`PearRuntime.run(entrypoint, args)`** and its instance alias **`pear.run(entrypoint, args)`**, returning an IPC duplex whose worker side is `Bare.IPC` ([Pear OTA runtime API](https://docs.pears.com/reference/pear/runtime/), [`pear-runtime` repository](https://github.com/holepunchto/pear-runtime)).

3. **Treat `pear-runtime` as current but provisional.** The current docs identify `pear-runtime` v1.3.1 as the embeddable OTA/runtime path, with `ready()`, `close()`, worker IPC, storage, and update events; its own official README still labels the project **“MVP and experimental.”** That is a concrete upstream status, not an inference ([runtime reference](https://docs.pears.com/reference/pear/runtime/), [official repository](https://github.com/holepunchto/pear-runtime)). Keep OTA updates outside the weekend MVP.

4. **Use the active starter, not the archived UI library.** The official `hello-pear-electron` starter was updated on 2026-08-07 and embeds `pear-runtime` with stock Electron; its current `package.json` has no `pear-electron` dependency ([starter repository](https://github.com/holepunchto/hello-pear-electron), [current package definition](https://github.com/holepunchto/hello-pear-electron/blob/main/package.json)). The separate [`holepunchto/pear-electron`](https://github.com/holepunchto/pear-electron) repository is archived/read-only even though the Pear module catalog still labels `pear-electron` stable ([module catalog](https://docs.pears.com/reference/modules/pear-modules/)). This conflict is a reason to avoid `pear-electron` APIs such as `ui.Window` in a new weekend MVP.

5. **The core building blocks have stronger status signals, but some reference-version labels lag the release page.** The versioned references label **Hyperswarm v4.17.0**, **Hypercore v11.34.0**, **Hyperbee v2.27.3**, and **Corestore v7.11.0** stable ([Hyperswarm](https://docs.pears.com/reference/building-blocks/hyperswarm/), [Hypercore](https://docs.pears.com/reference/building-blocks/hypercore/), [Hyperbee](https://docs.pears.com/reference/building-blocks/hyperbee/), [Corestore](https://docs.pears.com/reference/helpers/corestore/)). The newer 2026-07-30 release overview reports **Hypercore through v11.35.1**, **Corestore v7.12.0**, and **Hyperdrive v13.3.3**; use those as the fresher concrete version signals rather than assuming each reference-page header is the newest release ([release overview](https://docs.pears.com/release-overview/)). Hyperdrive and Autobase are current, documented, non-archived projects, but this note does not elevate repository activity into an extra stability promise ([Hyperdrive reference](https://docs.pears.com/reference/building-blocks/hyperdrive/), [Autobase reference](https://docs.pears.com/reference/building-blocks/autobase/), [`hyperdrive` repository](https://github.com/holepunchto/hyperdrive), [`autobase` repository](https://github.com/holepunchto/autobase)). `blind-pairing` has a current official README and is used by the current Pear chat guide, but its README gives no stable/experimental label; treat it as **status-unlabeled** ([official repository](https://github.com/holepunchto/blind-pairing), [current chat reshape guide](https://docs.pears.com/getting-started/build-a-peer-to-peer-chat/reshape-into-a-production-app/)).

## 1. DirectDrop — one-link, peer-to-peer file handoff

### Core concept

Drop one file into the sender window, copy a capability string, paste it into a second instance, and fetch the file directly from the sender. Keep the sender online during transfer; do not promise cloud-style availability.

### Why it showcases the stack

It makes four Pear/Holepunch properties visible at once: a UI host delegates P2P work to a Bare worker, Hyperdrive represents files, Hyperswarm discovers the peer and supplies an encrypted duplex connection, and replication happens without an application-owned server. Hyperswarm documents topic discovery over HyperDHT, Noise-based end-to-end encrypted connections, hole punching, and optional relay fallback ([Hyperswarm reference](https://docs.pears.com/reference/building-blocks/hyperswarm/)). Hyperdrive documents file metadata plus blob replication and direct integration with Hyperswarm ([Hyperdrive reference](https://docs.pears.com/reference/building-blocks/hyperdrive/)).

Do **not** call the copied drive key a password or claim encrypted storage. The verified claim is narrower: Hyperdrive identifies/verifies the replicated drive, and the Hyperswarm transport is end-to-end encrypted.

### Exact components and APIs

- **Host/worker:** official [`hello-pear-electron`](https://github.com/holepunchto/hello-pear-electron) layout; `PearRuntime.run(require.resolve('./worker.js'))` or the template's instance `pear.run(...)`; duplex IPC in the host and `Bare.IPC` in the worker ([runtime API](https://docs.pears.com/reference/pear/runtime/)).
- **Storage:** `corestore`; `new Corestore(pear.storage)`, `await store.ready()`, and `await store.close()` ([Corestore API](https://docs.pears.com/reference/helpers/corestore/)).
- **Filesystem:** `hyperdrive`; `new Hyperdrive(store[, key])`, `await drive.ready()`, `drive.put(path, buffer)`, `drive.entry(path)`, `drive.get(path)`, `drive.createReadStream(path)`, `drive.download(folder).done()`, `drive.key`, `drive.discoveryKey`, and `drive.close()` ([Hyperdrive API](https://docs.pears.com/reference/building-blocks/hyperdrive/)).
- **Discovery/transport:** `hyperswarm`; `new Hyperswarm()`, `swarm.join(drive.discoveryKey)`, `swarm.on('connection', socket => drive.replicate(socket))`, `await swarm.flush()`, and `await swarm.destroy()` ([Hyperswarm API](https://docs.pears.com/reference/building-blocks/hyperswarm/)). Hyperdrive's documented discovery pattern also uses `const done = drive.findingPeers()` and settles it after `swarm.flush()` so pending reads know discovery completed ([Hyperdrive replication example](https://docs.pears.com/reference/building-blocks/hyperdrive/)).
- **Capability encoding:** use the same `b4a` hex pattern as the official replication tutorials: sender displays `b4a.toString(drive.key, 'hex')`; receiver parses `b4a.from(key, 'hex')` before opening the read-only drive ([official Hyperbee sharing recipe](https://docs.pears.com/how-to/store-and-replicate/share-append-only-databases-with-hyperbee/), [`b4a` repository](https://github.com/holepunchto/b4a)).

### 30-second demo moment

1. Open two windows with different storage directories.
2. Drag `demo.pdf` into A; A shows its drive key.
3. Paste the key into B.
4. B changes from “finding peer” to “1 peer,” lists `demo.pdf`, downloads it, and opens the matching bytes while a visible counter advances.

### Weekend MVP boundary

- One sender and one receiver.
- One file at a time, maximum **25 MB**.
- Filename, byte size, progress, and success/error state only.
- Copy/paste a hex drive key; no QR service, accounts, contacts, or pairing backend.
- No folders, deletion, pause/resume, background seeding, history, write access for the receiver, or OTA release.

### Key technical risk

Crossing the Electron/Bare IPC boundary with a whole 25 MB buffer can create memory and framing problems. Cap files at 25 MB for the first pass; switch to chunked messages or worker-side file reads only after the two-instance path works. Also test “receiver starts before sender announces” and “sender exits mid-transfer.”

### Realistic build time: 16–19 hours

- **3 h:** starter, worker IPC, two storage directories
- **5 h:** Hyperdrive create/open and Hyperswarm replication
- **4 h:** file selection, progress, save/open path
- **2 h:** capability parsing and error states
- **2–5 h:** two-instance tests and demo polish

## 2. Live Markdown Broadcast — one writer, many live readers

### Core concept

A presenter edits one Markdown document. Every save appends a complete UTF-8 snapshot to a Hypercore; audience instances tail the log and render the newest revision.

### Why it showcases the stack

The append-only model is visible and easy to explain: every revision has an index in an authenticated, immutable history. Hypercore supports verified append-only logs, live/sparse replication, and read-only replicas opened from the writer's public key ([Hypercore reference](https://docs.pears.com/reference/building-blocks/hypercore/)). It demonstrates more than socket chat without taking on multiwriter conflict resolution.

### Exact components and APIs

- **Log:** `hypercore`; `new Hypercore(storage[, key], { valueEncoding: 'utf-8' })`, `await core.ready()`, `await core.append(markdown)`, `core.key`, `core.discoveryKey`, `core.length`, `await core.update()`, `await core.get(index)`, and `core.createReadStream({ start, live: true })` ([Hypercore API](https://docs.pears.com/reference/building-blocks/hypercore/)).
- **Replication:** `hyperswarm`; both sides `swarm.join(core.discoveryKey)`, then `swarm.on('connection', conn => core.replicate(conn))` ([official Hypercore replication recipe](https://docs.pears.com/how-to/store-and-replicate/replicate-and-persist-with-hypercore/)).
- **Host/worker:** `pear-runtime` static or instance `run(...)` plus `Bare.IPC`, starting from [`hello-pear-electron`](https://github.com/holepunchto/hello-pear-electron) ([runtime API](https://docs.pears.com/reference/pear/runtime/)).
- **Key encoding:** `b4a.toString(core.key, 'hex')` on the presenter and the inverse on readers, matching the official recipes ([Hypercore recipe](https://docs.pears.com/how-to/store-and-replicate/replicate-and-persist-with-hypercore/)).

### 30-second demo moment

1. Paste the presenter key into two audience windows.
2. Change the heading to “Round 2” and press Publish.
3. Both readers update immediately and show “revision 8.”
4. Click revision 6 in one reader to prove the history is still available.

### Weekend MVP boundary

- One writer; any number of read-only audience peers.
- One document, maximum **100 KB** per revision and **50 revisions** in the demo.
- Publish button rather than keystroke-level synchronization.
- Minimal Markdown subset or escaped plain text; no collaborative cursor, comments, images, permissions, or compaction.

### Key technical risk

A live stream can wait indefinitely, and a download range that includes the current end can remain open as future appends extend it; close streams and swarms explicitly on window shutdown ([Hypercore download warning and lifecycle](https://docs.pears.com/reference/building-blocks/hypercore/)). Keep renderer state keyed by Hypercore index so reconnects do not render the same revision twice.

### Realistic build time: 13–16 hours

- **3 h:** starter and IPC
- **4 h:** writer/reader core modes and replication
- **3 h:** editor, renderer, revision list
- **1 h:** key flow
- **2–5 h:** reconnect tests and demo polish

## 3. Pocket Field Guide — searchable data that replicates on demand

### Core concept

Ship a read-only field guide—interview prompts, plant facts, emergency procedures, or API notes—as a Hyperbee. A reader pastes the author's key and fetches only the blocks needed for each lookup, then keeps fetched results locally.

### Why it showcases the stack

The impressive moment is not “data synced”; it is **sparse, indexed retrieval from a remote append-only database**. Hyperbee is a sorted B-tree on Hypercore, supports exact/range queries and namespaces, and the official sharing guide says a reader downloads only the Hypercore blocks needed for a lookup ([Hyperbee reference](https://docs.pears.com/reference/building-blocks/hyperbee/), [official sharing guide](https://docs.pears.com/how-to/store-and-replicate/share-append-only-databases-with-hyperbee/)).

### Exact components and APIs

- **Store/core:** `corestore`; `new Corestore(storage)`, `store.get({ name: 'field-guide' })` for the writer, and `store.get({ key: b4a.from(key, 'hex') })` for a reader ([official sharing guide](https://docs.pears.com/how-to/store-and-replicate/share-append-only-databases-with-hyperbee/)).
- **Index:** `hyperbee`; `new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })`, `await db.ready()`, `await db.put(key, value)`, `await db.get(key)`, `db.sub(prefix)`, and `db.createReadStream({ gte, lt, limit })` ([Hyperbee API](https://docs.pears.com/reference/building-blocks/hyperbee/)).
- **Replication:** `hyperswarm`; `swarm.on('connection', conn => store.replicate(conn))`, `swarm.join(core.discoveryKey)`, and `await discovery.flushed()` on the writer before presenting its key ([official sharing guide](https://docs.pears.com/how-to/store-and-replicate/share-append-only-databases-with-hyperbee/)).
- **Host:** the active Electron starter or the current Bare starter, [`hello-pear-bare`](https://github.com/holepunchto/hello-pear-bare), if a polished terminal demo is enough.

### 30-second demo moment

1. A fresh reader shows that no guide has been opened.
2. Paste the author's key and search `hyperswarm`.
3. The answer arrives from the author's peer and the UI changes from “fetching” to “ready.”
4. Stop the author, repeat the same lookup, and show that the already-replicated blocks remain readable locally.

Do not demonstrate an uncached lookup after stopping the only author; official replication still requires a reachable peer that has the needed blocks.

### Weekend MVP boundary

- One author imports **200–500** JSON entries once.
- Read-only consumers; exact lookup plus one prefix-results list.
- One namespace such as `topics` via `db.sub('topics')`.
- Visible fetching/ready/error states; no cache accounting or full-text ranking.
- No remote writes, moderation, dataset merging, pagination, or guaranteed availability.

### Key technical risk

An uncached query can wait while no source peer is reachable. Use a visible **8-second** UI timeout and retry action; do not claim that `db.get()` itself guarantees a result without an online replica. Encoding is part of key ordering, so writer and reader must use identical `keyEncoding` and `valueEncoding` ([Hyperbee encoding rules](https://docs.pears.com/reference/building-blocks/hyperbee/)).

### Realistic build time: 14–17 hours

- **3 h:** dataset import and writer
- **4 h:** reader key flow and replication
- **3 h:** exact/prefix query UI
- **2 h:** cache/timeout states
- **2–5 h:** fixtures, tests, and demo polish

## 4. Room Pulse — ephemeral peer-to-peer voting

### Core concept

A host creates a random 32-byte room topic and shares it as hex. Peers join the same Hyperswarm topic, exchange a tiny newline-delimited JSON protocol over direct sockets, and display a live A/B vote and peer count.

### Why it showcases the stack

It isolates the network layer: topic discovery, encrypted peer connections, live membership, and direct application messages, with no database or backend to obscure the mechanism. Hyperswarm requires a 32-byte topic and exposes each connection as an end-to-end encrypted duplex stream plus `peerInfo.publicKey` ([Hyperswarm reference](https://docs.pears.com/reference/building-blocks/hyperswarm/)).

### Exact components and APIs

- **Network:** `hyperswarm`; `new Hyperswarm({ maxPeers: 16 })`, `swarm.join(topic, { server: true, client: true })`, `await discovery.flushed()`, `swarm.on('connection', (socket, peerInfo) => ...)`, `socket.write(...)`, `socket.on('data', ...)`, `swarm.connections`, and `await swarm.destroy()` ([Hyperswarm API](https://docs.pears.com/reference/building-blocks/hyperswarm/)).
- **Room code:** create exactly 32 random bytes in the Electron host and pass them to the worker over runtime IPC; encode/decode locally as 64 hex characters. No URL shortener, rendezvous API, or QR provider.
- **Deduplication:** count one current vote per `peerInfo.publicKey` and replace that peer's previous vote. Treat the Noise public key only as a connection identity, not as a verified human identity.
- **Host/worker:** current [`hello-pear-electron`](https://github.com/holepunchto/hello-pear-electron) architecture and `PearRuntime.run`/`Bare.IPC` ([runtime reference](https://docs.pears.com/reference/pear/runtime/)).

### 30-second demo moment

1. Create a room in A and paste its code into B and C.
2. The UI changes from 1 to 3 connected peers.
3. Vote A in B and B in C; all windows animate to the same **1–1** tally.
4. Close C and show the connected-peer count change immediately.

### Weekend MVP boundary

- One question with A/B choices.
- Maximum **16** connected peers.
- Ephemeral in-memory state; each peer sends its current vote on every new connection.
- Validate message type and cap each message at **1 KB**.
- No identities, signatures, persistence, historical results, moderation, public room directory, or claim of consensus under partitions.

### Key technical risk

A mesh can temporarily disagree during joins, reconnects, and partitions. Keep the claim to “live tally among currently connected peers,” not a durable global total. Anyone with the topic can join; encrypted transport is not the same as user authentication.

### Realistic build time: 12–14 hours

- **3 h:** starter, IPC, room-code handling
- **4 h:** socket framing and connection lifecycle
- **2 h:** vote deduplication
- **1 h:** tally UI
- **2–4 h:** malformed-message and reconnect tests

## 5. Mergeboard — a two-writer convergent checklist

### Core concept

Two invited peers add and toggle checklist items while disconnected or connected. When they reconnect, Autobase linearizes their writer histories and deterministically rebuilds the same materialized view.

### Why it showcases the stack

This is the deepest technical demo: separate writers append causal operations, Autobase produces an eventually consistent linearized order, and deterministic `open`/`apply` functions materialize the result. Autobase explicitly warns that newly learned causal information can reorder earlier entries, which makes deterministic view logic essential ([Autobase reference](https://docs.pears.com/reference/building-blocks/autobase/)).

### Exact components and APIs

- **Multiwriter log:** `autobase`; `new Autobase(store, bootstrap, { valueEncoding: 'json', open, apply })`, `await base.ready()`, `await base.append(operation)`, `base.discoveryKey`, `base.replicate(connection)`, `await base.update()`, `base.view`, `base.writable`, and `base.signedLength` ([Autobase API](https://docs.pears.com/reference/building-blocks/autobase/)).
- **Deterministic view:** `open(viewStore)` returns a named view core; `apply(nodes, view, host)` appends validated operations. A writer-admission operation is handled inside `apply` with `await host.addWriter(key, { indexer: true })`, rather than mutating membership from arbitrary UI state ([Autobase writer API](https://docs.pears.com/reference/building-blocks/autobase/)).
- **Replication:** `hyperswarm`; join `base.discoveryKey` and call `base.replicate(connection)` for each connection ([Autobase replication example](https://docs.pears.com/reference/building-blocks/autobase/)).
- **Invite exchange:** `blind-pairing`; `BlindPairing.createInvite(autobaseKey)` returns `{ invite, publicKey, discoveryKey }`; the existing member uses `addMember`, `candidate.open(publicKey)`, and `candidate.confirm({ key: autobaseKey })`. The joining peer saves the object returned by `addCandidate({ invite, userData, onadd })` and awaits its `.pairing` promise ([official `blind-pairing` README](https://github.com/holepunchto/blind-pairing)). Pairing exchanges application data; the app must still implement and validate its Autobase writer-admission operation.
- **Storage/host:** `corestore`, `pear-runtime`, and either current official starter. Corestore can co-replicate multiple managed Hypercores over one passed connection ([Corestore reference](https://docs.pears.com/reference/helpers/corestore/)).

### 30-second demo moment

1. Pair B to A with one copied invite.
2. Disconnect the peers.
3. A adds “Ship demo”; B adds “Record video.”
4. Reconnect them and show both boards converge to the same two items and signed progress.

### Weekend MVP boundary

- Exactly two authorized writers and one board.
- Operations: `add-item` and `toggle-item` only.
- Stable random item IDs generated by the UI; deterministic replay in the view.
- No delete, rename, reorder, third writer, role changes, account recovery, invite revocation, attachments, or polished offline indicator.
- Use blind pairing only after single-process Autobase tests and direct key exchange already work.

### Key technical risk

Writer admission and deterministic reduction can consume the entire weekend. `apply` must not depend on external mutable state or network calls, and optimistic writers require explicit validation before `host.ackWriter()` ([Autobase determinism and optimistic-writer rules](https://docs.pears.com/reference/building-blocks/autobase/)). If both direct-key writer admission and two-peer convergence are not working by hour **10**, cut blind pairing and demo a pre-authorized second writer.

### Realistic build time: 18–20 hours

- **5 h:** Autobase open/apply reducer and replay tests
- **4 h:** writer admission and two stores
- **3 h:** Hyperswarm replication
- **3 h:** checklist UI and offline operation queue
- **3–5 h:** pairing attempt, convergence tests, and demo polish

## Strongest recommendation: DirectDrop

Choose DirectDrop because it has **one authoritative writer**, a documented file abstraction, and a four-step demo that a reviewer understands without narration. Its core replication path is almost a direct composition of the official Hyperdrive and Hyperswarm APIs, while the main provisional dependency—`pear-runtime`—is isolated to host/worker execution rather than the data model. Live Markdown is the fallback if file IPC takes more than **2 hours**: it preserves the same host, Hyperswarm, capability-copy, and read-only-replica story while replacing files with small Hypercore blocks.

## Unsupported assumptions to keep out of every demo

- **No app-owned server does not mean guaranteed availability.** Discovery uses HyperDHT, and an uncached block still needs a reachable peer that has it ([peer-to-peer explanation](https://docs.pears.com/explanation/peer-to-peer-demystified/)).
- **Encrypted transport does not imply authenticated people or encrypted-at-rest content.** Only make the Noise-encrypted-connection claim documented by Hyperswarm ([Hyperswarm reference](https://docs.pears.com/reference/building-blocks/hyperswarm/)).
- **A drive/core public key is not a write key.** Use it for a read-only replica; never send a writer secret in an invite or UI log ([Hypercore key model](https://docs.pears.com/reference/building-blocks/hypercore/)).
- **Do not use removed Pear v2 examples.** `global.Pear`, `Pear.app`, `Pear.teardown()`, `Pear.worker`, old `Pear.Window`, and the `pear run` command are removed in Pear v3; use Bare APIs, `pear-runtime`, and the current starter architecture instead ([removed API reference](https://docs.pears.com/reference/pear/api/), [Pear v3 release overview](https://docs.pears.com/release-overview/)).
- **Do not promise production stability from repository freshness.** Active commits are evidence of maintenance only. `pear-runtime` remains explicitly experimental, `pear-electron` is archived, and `blind-pairing` has no official stability label in its README as verified on 2026-08-08.
