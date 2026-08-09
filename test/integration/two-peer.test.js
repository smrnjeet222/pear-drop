const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { EventEmitter } = require('node:events')

const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')

const { createTemporaryPath } = require('../../lib/file-policy')
const TransferEngine = require('../../lib/transfer-engine')

test(
  'two peers transfer exact bytes over a local DHT and clean an interrupted handoff',
  { timeout: 30_000 },
  async (t) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peardrop-two-peer-'))
    const testnet = await createTestnet(3)
    const sourcePath = path.join(dir, 'source.bin')
    const destinationPath = path.join(dir, 'received.bin')
    const interruptedPath = path.join(dir, 'interrupted.bin')
    const fixture = b4a.alloc(1024 * 1024)
    for (let index = 0; index < fixture.length; index++) fixture[index] = index % 251
    await fs.promises.writeFile(sourcePath, fixture)

    const deadlines = {
      ingest: 5_000,
      announce: 5_000,
      discovery: 5_000,
      stall: 3_000,
      total: 5_000,
      cleanup: 1_000,
      shutdown: 2_000
    }
    let senderSwarm = null
    const sender = new TransferEngine({
      store: new Corestore(path.join(dir, 'sender-store')),
      filesystem: fs,
      path,
      createSwarm: () => {
        senderSwarm = new ControlledSwarm({ dht: testnet.createNode() })
        return senderSwarm
      },
      deadlines
    })
    const receiver = new TransferEngine({
      store: new Corestore(path.join(dir, 'receiver-store')),
      filesystem: fs,
      path,
      createSwarm: () => new Hyperswarm({ dht: testnet.createNode() }),
      deadlines
    })

    t.after(async () => {
      await Promise.allSettled([sender.close(), receiver.close()])
      await testnet.destroy().catch(() => {})
      await fs.promises.rm(dir, { recursive: true, force: true })
    })

    const progress = []
    const receiverEvents = []
    const activeProgress = deferred()
    let interruptedRequestId = null
    let interruptionStarted = 0
    let stopSender = null
    receiver.onEvent((event) => {
      receiverEvents.push(event)
      if (event.type === 'transfer.progress') progress.push(event.transferred)
      if (
        event.type === 'transfer.progress' &&
        event.requestId === interruptedRequestId &&
        event.transferred > 0 &&
        event.transferred < event.total &&
        !stopSender
      ) {
        interruptionStarted = Date.now()
        stopSender = sender.dispatch({
          type: 'transfer.cancel',
          requestId: interruptedRequestId
        })
        activeProgress.resolve(event)
      }
    })

    const firstRequestId = randomUUID()
    const shared = await sender.dispatch({
      type: 'share.start',
      requestId: firstRequestId,
      sourcePath
    })
    const inspected = await receiver.dispatch({
      type: 'receive.inspect',
      requestId: firstRequestId,
      capability: shared.capability
    })

    assert.equal(inspected.writable, false)
    assert.deepEqual(inspected.file, { name: 'source.bin', size: fixture.byteLength })

    await receiver.dispatch({
      type: 'receive.start',
      requestId: firstRequestId,
      destinationPath
    })

    assert.equal(receiver.snapshot().state, 'completed')
    assert.deepEqual(await fs.promises.readFile(destinationPath), fixture)
    assert.ok(progress.length >= 2)
    assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]))
    assert.equal(progress.at(-1), fixture.byteLength)

    await sender.dispatch({ type: 'transfer.cancel', requestId: firstRequestId })
    await receiver.dispatch({ type: 'transfer.reset', requestId: firstRequestId })

    const secondRequestId = randomUUID()
    interruptedRequestId = secondRequestId
    const secondShare = await sender.dispatch({
      type: 'share.start',
      requestId: secondRequestId,
      sourcePath
    })
    await receiver.dispatch({
      type: 'receive.inspect',
      requestId: secondRequestId,
      capability: secondShare.capability
    })
    senderSwarm.throttleWrites()

    const receiving = receiver.dispatch({
      type: 'receive.start',
      requestId: secondRequestId,
      destinationPath: interruptedPath
    })
    receiving.catch(() => {})
    const middle = await within(activeProgress.promise, 5_000)
    assert.ok(middle.transferred > 0 && middle.transferred < middle.total)
    await stopSender
    await assert.rejects(receiving, (err) =>
      ['TRANSFER_STALLED', 'CONNECTION_LOST'].includes(err.code)
    )

    assert.ok(Date.now() - interruptionStarted < 4_000)
    assert.equal(receiver.snapshot().state, 'failed')
    assert.equal(
      receiverEvents.some(
        (event) =>
          event.requestId === secondRequestId &&
          event.type === 'state.changed' &&
          event.state === 'completed'
      ),
      false
    )
    assert.equal(await exists(interruptedPath), false)
    assert.equal(await exists(createTemporaryPath(interruptedPath, secondRequestId)), false)
  }
)

async function exists(filePath) {
  try {
    await fs.promises.access(filePath)
    return true
  } catch {
    return false
  }
}

class ControlledSwarm extends EventEmitter {
  constructor(options) {
    super()
    this.swarm = new Hyperswarm(options)
    this.sockets = new Set()
    this.swarm.on('connection', (socket, info) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
      this.emit('connection', socket, info)
    })
    this.swarm.on('update', () => this.emit('update'))
  }

  get connections() {
    return this.swarm.connections
  }

  join(...args) {
    return this.swarm.join(...args)
  }

  flush() {
    return this.swarm.flush()
  }

  throttleWrites() {
    for (const socket of this.sockets) throttleRawWrites(socket)
  }

  destroy(...args) {
    return this.swarm.destroy(...args)
  }
}

function throttleRawWrites(socket) {
  const raw = socket._rawStream
  if (!raw || typeof raw._write !== 'function') {
    throw new Error('Hyperswarm socket does not expose a writable raw stream.')
  }

  const write = raw._write.bind(raw)
  raw._write = (data, callback) => {
    let offset = 0
    const writeNext = () => {
      if (offset >= data.byteLength) {
        callback(null)
        return
      }

      const nextOffset = Math.min(offset + 4 * 1024, data.byteLength)
      write(data.subarray(offset, nextOffset), (err) => {
        if (err) {
          callback(err)
          return
        }
        offset = nextOffset
        setTimeout(writeNext, 2)
      })
    }
    writeNext()
  }
}

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function within(promise, timeout) {
  let timer
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Timed out waiting for active transfer progress.')),
      timeout
    )
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}
