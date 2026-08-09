const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const Corestore = require('corestore')
const FramedStream = require('framed-stream')
const goodbye = require('graceful-goodbye')
const Hyperswarm = require('hyperswarm')

const { createRequestTracker, parseFrame, serializeFrame } = require('../lib/protocol')
const TransferEngine = require('../lib/transfer-engine')

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const storagePath = Bare.argv[2]
const pipe = new FramedStream(Bare.IPC)
const tracker = createRequestTracker()
const store = new Corestore(storagePath)
const engine = new TransferEngine({
  store,
  filesystem: fs,
  path,
  createSwarm: () => new Hyperswarm(),
  logError: (err) => console.error(err)
})

let accepting = true
let closing = null
const dispatching = new Set()
const reported = new Set()

const unsubscribe = engine.onEvent((event) => {
  if (event.type === 'transfer.error' && dispatching.has(event.requestId)) {
    reported.add(event.requestId)
  }
  send({ v: 1, ...event })
})

pipe.on('data', onFrame)
pipe.once('error', () => shutdown(false))
pipe.once('close', () => shutdown(false))

const unregisterGoodbye = goodbye(() => shutdown(false))

start().catch((err) => {
  console.error(err)
  shutdown(false)
})

async function start() {
  if (typeof storagePath !== 'string' || storagePath.length === 0) {
    throw new Error('PearDrop worker storage path is required')
  }

  await store.ready()
  send({ v: 1, type: 'worker.ready', snapshot: engine.snapshot() })
}

function onFrame(frame) {
  if (!accepting) return

  let command
  try {
    command = parseFrame(frame)
  } catch {
    const requestId = extractRequestId(frame)
    if (requestId) sendError(requestId, 'INVALID_FRAME', 'Worker command was rejected.', false)
    return
  }

  let status
  try {
    status = tracker.accept(command)
  } catch (err) {
    sendError(
      command.requestId,
      err.code || 'INVALID_STATE',
      'Finish or cancel this handoff first.',
      false
    )
    return
  }

  send({
    v: 1,
    type: 'command.accepted',
    requestId: command.requestId,
    command: command.type
  })

  if (status === 'duplicate') {
    sendState(command.requestId, engine.snapshot())
    return
  }

  if (command.type === 'worker.shutdown') {
    accepting = false
    shutdown(true)
    return
  }

  dispatching.add(command.requestId)
  Promise.resolve(engine.dispatch(command))
    .then((snapshot) => {
      if (command.type === 'state.get') sendState(command.requestId, snapshot)
    })
    .catch((err) => {
      if (err?.code === 'CANCELLED') return
      if (reported.delete(command.requestId)) return
      const normalized = TransferEngine.publicError(err)
      send({
        v: 1,
        type: 'transfer.error',
        requestId: command.requestId,
        error: normalized
      })
    })
    .finally(() => dispatching.delete(command.requestId))
}

function sendState(requestId, snapshot) {
  const message = {
    v: 1,
    type: 'state.changed',
    requestId,
    mode: snapshot.mode,
    state: snapshot.state
  }
  if (snapshot.file) message.file = snapshot.file
  if (snapshot.capability) message.capability = snapshot.capability
  if (snapshot.bytes) message.bytes = snapshot.bytes
  if (Number.isInteger(snapshot.peers)) message.peers = snapshot.peers
  send(message)
}

function sendError(requestId, code, message, retryable) {
  send({
    v: 1,
    type: 'transfer.error',
    requestId,
    error: { code, message, retryable }
  })
}

function send(message) {
  if (pipe.destroying || pipe.destroyed) return false
  try {
    return pipe.write(serializeFrame(message))
  } catch (err) {
    console.error(err)
    return false
  }
}

function extractRequestId(frame) {
  try {
    const value = JSON.parse(typeof frame === 'string' ? frame : b4a.toString(frame))
    return typeof value?.requestId === 'string' && REQUEST_ID.test(value.requestId)
      ? value.requestId
      : null
  } catch {
    return null
  }
}

function shutdown(notify) {
  if (closing) return closing

  accepting = false
  pipe.removeListener('data', onFrame)
  unregisterGoodbye()
  unsubscribe()

  closing = engine
    .close()
    .catch((err) => console.error(err))
    .then(() => {
      tracker.clear()
      if (notify) send({ v: 1, type: 'worker.closed' })
      if (!pipe.destroying && !pipe.destroyed) pipe.end()
    })

  return closing
}
