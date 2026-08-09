const test = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough, Duplex } = require('node:stream')
const { randomUUID } = require('node:crypto')

const FramedStream = require('framed-stream')

const { parseFrame, serializeFrame } = require('../lib/protocol')
const WorkerBroker = require('../electron/worker-broker')

test('worker broker waits for ready and command acknowledgements', async () => {
  const [hostRaw, workerRaw] = duplexPair()
  hostRaw.stdout = new PassThrough()
  hostRaw.stderr = new PassThrough()
  const workerPipe = new FramedStream(workerRaw)
  workerPipe.on('error', () => {})
  const runtime = { run: () => hostRaw }

  workerPipe.on('data', (frame) => {
    const command = parseFrame(frame)
    workerPipe.write(
      serializeFrame({
        v: 1,
        type: 'command.accepted',
        requestId: command.requestId,
        command: command.type
      })
    )
    if (command.type === 'worker.shutdown') {
      workerPipe.write(serializeFrame({ v: 1, type: 'worker.closed' }))
    }
  })

  const broker = new WorkerBroker({
    runtime,
    entrypoint: '/fixed/workers/main.js',
    storagePath: '/fixed/store',
    readyTimeout: 200,
    acknowledgeTimeout: 100,
    shutdownTimeout: 200
  })

  setImmediate(() => {
    workerPipe.write(
      serializeFrame({
        v: 1,
        type: 'worker.ready',
        snapshot: { mode: null, state: 'idle', requestId: null }
      })
    )
  })

  assert.deepEqual(await broker.start(), { mode: null, state: 'idle', requestId: null })

  const requestId = randomUUID()
  const accepted = await broker.command('share.start', requestId, { sourcePath: '/tmp/source' })
  assert.equal(accepted.command, 'share.start')
  assert.deepEqual(broker.snapshot(), { mode: null, state: 'idle', requestId: null })

  await broker.shutdown()
})

test('worker broker bounds missing readiness and acknowledgements', async () => {
  const [hostRaw, workerRaw] = duplexPair()
  hostRaw.stdout = new PassThrough()
  hostRaw.stderr = new PassThrough()
  const workerPipe = new FramedStream(workerRaw)
  workerPipe.on('error', () => {})
  const broker = new WorkerBroker({
    runtime: { run: () => hostRaw },
    entrypoint: '/fixed/workers/main.js',
    storagePath: '/fixed/store',
    readyTimeout: 30,
    acknowledgeTimeout: 30,
    shutdownTimeout: 30
  })

  await assert.rejects(broker.start(), (err) => err.code === 'WORKER_NOT_READY')

  workerPipe.destroy()
  await broker.shutdown()
})

test('worker crash converts an active transfer to an authoritative failed state', async () => {
  const [hostRaw, workerRaw] = duplexPair()
  hostRaw.stdout = new PassThrough()
  hostRaw.stderr = new PassThrough()
  const workerPipe = new FramedStream(workerRaw)
  workerPipe.on('error', () => {})
  const broker = new WorkerBroker({
    runtime: { run: () => hostRaw },
    entrypoint: '/fixed/workers/main.js',
    storagePath: '/fixed/store',
    readyTimeout: 200,
    shutdownTimeout: 30
  })
  const events = []
  broker.onEvent((event) => events.push(event))

  setImmediate(() => {
    workerPipe.write(
      serializeFrame({
        v: 1,
        type: 'worker.ready',
        snapshot: { mode: null, state: 'idle', requestId: null }
      })
    )
  })
  await broker.start()

  const requestId = randomUUID()
  workerPipe.write(
    serializeFrame({
      v: 1,
      type: 'state.changed',
      requestId,
      mode: 'send',
      state: 'sharing',
      file: { name: 'fixture.bin', size: 12 },
      capability: 'ab'.repeat(32),
      peers: 0
    })
  )
  await new Promise((resolve) => setImmediate(resolve))
  hostRaw.emit('exit', 1)

  assert.deepEqual(broker.snapshot(), {
    mode: 'send',
    state: 'failed',
    requestId,
    file: { name: 'fixture.bin', size: 12 },
    capability: 'ab'.repeat(32),
    peers: 0
  })
  assert.equal(events.at(-2).type, 'state.changed')
  assert.equal(events.at(-2).state, 'failed')
  assert.equal(events.at(-1).type, 'transfer.error')
  assert.equal(events.at(-1).error.code, 'WORKER_CRASHED')

  await broker.shutdown()
})

function duplexPair() {
  const leftToRight = new PassThrough()
  const rightToLeft = new PassThrough()
  const left = Duplex.from({ readable: rightToLeft, writable: leftToRight })
  const right = Duplex.from({ readable: leftToRight, writable: rightToLeft })
  return [left, right]
}
