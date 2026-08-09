const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const b4a = require('b4a')
const Corestore = require('corestore')

const TransferEngine = require('../lib/transfer-engine')

class LocalOnlySwarm extends EventEmitter {
  constructor() {
    super()
    this.connections = new Set()
    this.destroyed = false
  }

  join() {
    return { destroy: async () => {} }
  }

  async flush() {}

  async destroy() {
    this.destroyed = true
  }
}

test(
  'sender streams one file, remains sharing, and cancels back to idle',
  { timeout: 5_000 },
  async (t) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peardrop-lifecycle-'))
    const sourcePath = path.join(dir, 'fixture.bin')
    const fixture = b4a.alloc(256 * 1024, 0x5a)
    await fs.promises.writeFile(sourcePath, fixture)

    const engine = new TransferEngine({
      store: new Corestore(path.join(dir, 'store')),
      filesystem: fs,
      path,
      createSwarm: () => new LocalOnlySwarm(),
      deadlines: { ingest: 2_000, announce: 500, cleanup: 500, shutdown: 1_000 }
    })
    t.after(async () => {
      await engine.close()
      await fs.promises.rm(dir, { recursive: true, force: true })
    })

    const events = []
    engine.onEvent((event) => events.push(event))
    const requestId = randomUUID()

    await engine.dispatch({ type: 'share.start', requestId, sourcePath })

    const sharing = engine.snapshot()
    assert.equal(sharing.mode, 'send')
    assert.equal(sharing.state, 'sharing')
    assert.equal(sharing.file.name, 'fixture.bin')
    assert.equal(sharing.file.size, fixture.byteLength)
    assert.match(sharing.capability, /^[0-9a-f]{64}$/)

    const progress = events.filter((event) => event.type === 'transfer.progress')
    assert.ok(progress.length >= 1)
    assert.equal(progress.at(-1).transferred, fixture.byteLength)
    assert.equal(progress.at(-1).total, fixture.byteLength)

    await engine.dispatch({ type: 'transfer.cancel', requestId })
    assert.deepEqual(engine.snapshot(), { mode: null, state: 'idle', requestId: null })

    await engine.close()
    await engine.close()
  }
)

test(
  'receiver discovery is bounded and resettable when no sender is available',
  { timeout: 2_000 },
  async (t) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peardrop-unavailable-'))
    const engine = new TransferEngine({
      store: new Corestore(path.join(dir, 'store')),
      filesystem: fs,
      path,
      createSwarm: () => new LocalOnlySwarm(),
      deadlines: { discovery: 50, cleanup: 500, shutdown: 1_000 }
    })
    t.after(async () => {
      await engine.close()
      await fs.promises.rm(dir, { recursive: true, force: true })
    })

    const requestId = randomUUID()
    await assert.rejects(
      engine.dispatch({ type: 'receive.inspect', requestId, capability: 'ab'.repeat(32) }),
      (err) => err.code === 'SENDER_UNAVAILABLE'
    )
    assert.equal(engine.snapshot().state, 'failed')

    await engine.dispatch({ type: 'transfer.reset', requestId })
    assert.deepEqual(engine.snapshot(), { mode: null, state: 'idle', requestId: null })
  }
)

test('receiver cancellation settles while discovery is pending', { timeout: 2_000 }, async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peardrop-cancel-'))
  const engine = new TransferEngine({
    store: new Corestore(path.join(dir, 'store')),
    filesystem: fs,
    path,
    createSwarm: () => new LocalOnlySwarm(),
    deadlines: { discovery: 5_000, cleanup: 500, shutdown: 1_000 }
  })
  t.after(async () => {
    await engine.close()
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  const requestId = randomUUID()
  const inspecting = engine.dispatch({
    type: 'receive.inspect',
    requestId,
    capability: 'cd'.repeat(32)
  })

  await new Promise((resolve) => setImmediate(resolve))
  await engine.dispatch({ type: 'transfer.cancel', requestId })

  await assert.rejects(inspecting, (err) => err.code === 'CANCELLED')
  assert.deepEqual(engine.snapshot(), { mode: null, state: 'idle', requestId: null })
})

test(
  'active receive cancellation destroys resources in order and removes the partial file',
  { timeout: 5_000 },
  async (t) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peardrop-active-cancel-'))
    const destinationPath = path.join(dir, 'received.bin')
    const requestId = randomUUID()
    const order = []
    const events = []
    const source = new PassThrough()
    let sourceDestroyRecorded = false
    const destroySource = source.destroy.bind(source)
    source.destroy = (...args) => {
      if (!sourceDestroyRecorded) order.push('stream.destroy:drive')
      sourceDestroyRecorded = true
      return destroySource(...args)
    }

    class FakeHyperdrive {
      constructor() {
        this.discoveryKey = b4a.alloc(32, 0x42)
        this.writable = false
      }

      ready() {
        return Promise.resolve()
      }

      findingPeers() {
        return () => {}
      }

      update() {
        return Promise.resolve()
      }

      entry() {
        return Promise.resolve({
          value: {
            metadata: { schema: 'peardrop/1', name: 'fixture.bin', size: 16 },
            blob: { byteLength: 16 }
          }
        })
      }

      createReadStream() {
        setTimeout(() => source.write(b4a.alloc(4, 0x2a)), 120)
        return source
      }

      close() {
        order.push('drive.close')
        return Promise.resolve()
      }
    }

    const transferStore = {
      replicate() {},
      close() {
        order.push('session.close')
        return Promise.resolve()
      }
    }
    const store = {
      ready: () => Promise.resolve(),
      session: () => transferStore,
      close: () => Promise.resolve()
    }
    const swarm = new EventEmitter()
    swarm.connections = new Set()
    swarm.destroyed = false
    swarm.join = () => ({
      destroy() {
        order.push('discovery.destroy')
        return Promise.resolve()
      }
    })
    swarm.flush = () => Promise.resolve()
    swarm.destroy = () => {
      swarm.destroyed = true
      order.push('swarm.destroy')
      return Promise.resolve()
    }

    const filesystem = {
      ...fs,
      promises: {
        ...fs.promises,
        async unlink(filePath) {
          try {
            await fs.promises.unlink(filePath)
            order.push('partial.unlink')
          } catch (err) {
            if (err.code !== 'ENOENT') throw err
          }
        }
      },
      createWriteStream(filePath, options) {
        const output = fs.createWriteStream(filePath, options)
        const destroyOutput = output.destroy.bind(output)
        let recorded = false
        output.destroy = (...args) => {
          if (!recorded) order.push('stream.destroy:output')
          recorded = true
          return destroyOutput(...args)
        }
        return output
      }
    }

    const engine = new TransferEngine({
      store,
      filesystem,
      path,
      Hyperdrive: FakeHyperdrive,
      createSwarm: () => swarm,
      deadlines: { discovery: 500, stall: 2_000, cleanup: 1_000, shutdown: 1_000 }
    })
    engine.onEvent((event) => events.push(event))
    t.after(async () => {
      await engine.close()
      await fs.promises.rm(dir, { recursive: true, force: true })
    })

    await engine.dispatch({
      type: 'receive.inspect',
      requestId,
      capability: 'ef'.repeat(32)
    })
    const receiving = engine.dispatch({ type: 'receive.start', requestId, destinationPath })
    receiving.catch(() => {})
    const temporaryPath = `${destinationPath}.peardrop-${requestId}.part`
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'transfer.progress' &&
            event.requestId === requestId &&
            event.transferred > 0 &&
            event.transferred < event.total
        ) && exists(temporaryPath),
      1_000
    )

    const started = Date.now()
    await engine.dispatch({ type: 'transfer.cancel', requestId })
    assert.ok(Date.now() - started < 2_000)
    await assert.rejects(receiving, (err) => err.code === 'CANCELLED')

    assert.deepEqual(engine.snapshot(), { mode: null, state: 'idle', requestId: null })
    assert.equal(swarm.destroyed, true)
    assert.equal(await exists(destinationPath), false)
    assert.equal(await exists(temporaryPath), false)
    assert.equal(
      events.filter(
        (event) =>
          event.type === 'state.changed' && event.requestId === requestId && event.state === 'idle'
      ).length,
      1
    )
    assert.equal(
      events.some(
        (event) =>
          event.requestId === requestId &&
          event.type === 'state.changed' &&
          event.state === 'completed'
      ),
      false
    )

    assert.ok(order.indexOf('stream.destroy:drive') < order.indexOf('discovery.destroy'))
    assert.ok(order.indexOf('stream.destroy:output') < order.indexOf('discovery.destroy'))
    assert.ok(order.indexOf('discovery.destroy') < order.indexOf('swarm.destroy'))
    assert.ok(order.indexOf('swarm.destroy') < order.indexOf('partial.unlink'))
    assert.ok(order.indexOf('partial.unlink') < order.indexOf('drive.close'))
    assert.ok(order.indexOf('partial.unlink') < order.indexOf('session.close'))
  }
)

test('partial cleanup failure keeps the transfer failed until reset retries it', async (t) => {
  const requestId = randomUUID()
  const source = new PassThrough()
  const output = new PassThrough()
  const events = []
  let unlinkCalls = 0

  class FakeHyperdrive {
    constructor() {
      this.discoveryKey = b4a.alloc(32, 0x29)
      this.writable = false
    }

    ready() {
      return Promise.resolve()
    }

    findingPeers() {
      return () => {}
    }

    update() {
      return Promise.resolve()
    }

    entry() {
      return Promise.resolve({
        value: {
          metadata: { schema: 'peardrop/1', name: 'fixture.bin', size: 16 },
          blob: { byteLength: 16 }
        }
      })
    }

    createReadStream() {
      return source
    }

    close() {
      return Promise.resolve()
    }
  }

  const transferStore = { replicate() {}, close: () => Promise.resolve() }
  const engine = new TransferEngine({
    store: {
      ready: () => Promise.resolve(),
      session: () => transferStore,
      close: () => Promise.resolve()
    },
    filesystem: {
      promises: {
        unlink() {
          unlinkCalls += 1
          if (unlinkCalls === 2) {
            const error = new Error('partial file is protected')
            error.code = 'EACCES'
            return Promise.reject(error)
          }
          return Promise.resolve()
        }
      },
      createWriteStream: () => output
    },
    path,
    Hyperdrive: FakeHyperdrive,
    createSwarm: () => new LocalOnlySwarm(),
    deadlines: { discovery: 100, stall: 1_000, total: 1_000, cleanup: 100, shutdown: 100 }
  })
  engine.onEvent((event) => events.push(event))
  t.after(() => engine.close())

  await engine.dispatch({
    type: 'receive.inspect',
    requestId,
    capability: '10'.repeat(32)
  })
  const receiving = engine.dispatch({
    type: 'receive.start',
    requestId,
    destinationPath: '/received.bin'
  })
  receiving.catch(() => {})
  await waitFor(
    () =>
      events.some(
        (event) => event.type === 'transfer.progress' && event.requestId === requestId
      ),
    100
  )

  await assert.rejects(
    engine.dispatch({ type: 'transfer.cancel', requestId }),
    (error) => error.code === 'INTERNAL'
  )
  await assert.rejects(receiving, (error) => error.code === 'CANCELLED')
  assert.equal(engine.snapshot().state, 'failed')
  assert.equal(
    events.some(
      (event) => event.type === 'transfer.error' && event.error.code === 'INTERNAL'
    ),
    true
  )

  await engine.dispatch({ type: 'transfer.reset', requestId })
  assert.deepEqual(engine.snapshot(), { mode: null, state: 'idle', requestId: null })
  assert.equal(unlinkCalls, 3)
})

test('resource cleanup deadline keeps the transfer failed until close can be retried', async (t) => {
  const requestId = randomUUID()
  let resolveDriveClose
  const driveClose = new Promise((resolve) => {
    resolveDriveClose = resolve
  })
  let resolveSessionClose
  const sessionClose = new Promise((resolve) => {
    resolveSessionClose = resolve
  })

  class FakeHyperdrive {
    constructor() {
      this.discoveryKey = b4a.alloc(32, 0x28)
      this.writable = false
    }

    ready() {
      return Promise.resolve()
    }

    findingPeers() {
      return () => {}
    }

    update() {
      return Promise.resolve()
    }

    entry() {
      return Promise.resolve({
        value: {
          metadata: { schema: 'peardrop/1', name: 'fixture.bin', size: 16 },
          blob: { byteLength: 16 }
        }
      })
    }

    close() {
      return driveClose
    }
  }

  const transferStore = { replicate() {}, close: () => sessionClose }
  const engine = new TransferEngine({
    store: {
      ready: () => Promise.resolve(),
      session: () => transferStore,
      close: () => Promise.resolve()
    },
    filesystem: { promises: {} },
    path,
    Hyperdrive: FakeHyperdrive,
    createSwarm: () => new LocalOnlySwarm(),
    deadlines: { discovery: 100, cleanup: 10, shutdown: 100 }
  })
  t.after(() => engine.close())

  await engine.dispatch({
    type: 'receive.inspect',
    requestId,
    capability: '0f'.repeat(32)
  })
  await assert.rejects(
    engine.dispatch({ type: 'transfer.cancel', requestId }),
    (error) => error.code === 'INTERNAL'
  )
  assert.equal(engine.snapshot().state, 'failed')

  resolveDriveClose()
  resolveSessionClose()
  await engine.dispatch({ type: 'transfer.reset', requestId })
  assert.deepEqual(engine.snapshot(), { mode: null, state: 'idle', requestId: null })
})

test('receiver cancellation observes discovery update rejection', async (t) => {
  const requestId = randomUUID()
  let rejectUpdate
  let updateStarted
  const started = new Promise((resolve) => {
    updateStarted = resolve
  })
  let doneFindingCalls = 0
  let unhandled = null
  const onUnhandled = (error) => {
    unhandled = error
  }
  process.on('unhandledRejection', onUnhandled)

  class FakeHyperdrive {
    constructor() {
      this.discoveryKey = b4a.alloc(32, 0x30)
      this.writable = false
    }

    ready() {
      return Promise.resolve()
    }

    findingPeers() {
      return () => {
        doneFindingCalls += 1
      }
    }

    update() {
      updateStarted()
      return new Promise((resolve, reject) => {
        rejectUpdate = reject
      })
    }

    close() {
      rejectUpdate(new Error('update aborted by close'))
      return Promise.resolve()
    }
  }

  const transferStore = { replicate() {}, close: () => Promise.resolve() }
  const swarm = new LocalOnlySwarm()
  swarm.flush = () => new Promise(() => {})
  const engine = new TransferEngine({
    store: {
      ready: () => Promise.resolve(),
      session: () => transferStore,
      close: () => Promise.resolve()
    },
    filesystem: { promises: {} },
    path,
    Hyperdrive: FakeHyperdrive,
    createSwarm: () => swarm,
    deadlines: { discovery: 1_000, cleanup: 100, shutdown: 100 }
  })
  t.after(async () => {
    process.removeListener('unhandledRejection', onUnhandled)
    await engine.close()
  })

  const inspecting = engine.dispatch({
    type: 'receive.inspect',
    requestId,
    capability: '11'.repeat(32)
  })
  inspecting.catch(() => {})
  await started
  await engine.dispatch({ type: 'transfer.cancel', requestId })
  await assert.rejects(inspecting, (error) => error.code === 'CANCELLED')
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(unhandled, null)
  assert.equal(doneFindingCalls, 1)
  assert.deepEqual(engine.snapshot(), { mode: null, state: 'idle', requestId: null })
})

test('receive timeout closes both streams and rejects late progress', async (t) => {
  const requestId = randomUUID()
  const source = new PassThrough()
  const output = new PassThrough()
  const events = []

  class FakeHyperdrive {
    constructor() {
      this.discoveryKey = b4a.alloc(32, 0x31)
      this.writable = false
    }

    ready() {
      return Promise.resolve()
    }

    findingPeers() {
      return () => {}
    }

    update() {
      return Promise.resolve()
    }

    entry() {
      return Promise.resolve({
        value: {
          metadata: { schema: 'peardrop/1', name: 'fixture.bin', size: 16 },
          blob: { byteLength: 16 }
        }
      })
    }

    createReadStream() {
      return source
    }

    close() {
      return Promise.resolve()
    }
  }

  const transferStore = { replicate() {}, close: () => Promise.resolve() }
  const store = {
    ready: () => Promise.resolve(),
    session: () => transferStore,
    close: () => Promise.resolve()
  }
  const filesystem = {
    promises: {
      unlink: () => Promise.resolve()
    },
    createWriteStream: () => output
  }
  const engine = new TransferEngine({
    store,
    filesystem,
    path,
    Hyperdrive: FakeHyperdrive,
    createSwarm: () => new LocalOnlySwarm(),
    deadlines: {
      discovery: 100,
      total: 10,
      stall: 1_000,
      cleanup: 100,
      shutdown: 100
    }
  })
  engine.onEvent((event) => events.push(event))
  t.after(() => engine.close())

  await engine.dispatch({
    type: 'receive.inspect',
    requestId,
    capability: '12'.repeat(32)
  })
  await assert.rejects(
    engine.dispatch({ type: 'receive.start', requestId, destinationPath: '/received.bin' }),
    (error) => error.code === 'TRANSFER_TIMEOUT'
  )

  assert.equal(source.destroyed, true)
  assert.equal(output.destroyed, true)
  const progressAtFailure = events.filter((event) => event.type === 'transfer.progress').length
  await new Promise((resolve) => setTimeout(resolve, 110))
  source.emit('data', b4a.alloc(4))
  assert.equal(
    events.filter((event) => event.type === 'transfer.progress').length,
    progressAtFailure
  )
  assert.equal(engine.snapshot().bytes.transferred, 0)
})

test('destination stream failure closes the drive stream', async (t) => {
  const requestId = randomUUID()
  const source = new PassThrough()
  const output = new PassThrough()

  class FakeHyperdrive {
    constructor() {
      this.discoveryKey = b4a.alloc(32, 0x32)
      this.writable = false
    }

    ready() {
      return Promise.resolve()
    }

    findingPeers() {
      return () => {}
    }

    update() {
      return Promise.resolve()
    }

    entry() {
      return Promise.resolve({
        value: {
          metadata: { schema: 'peardrop/1', name: 'fixture.bin', size: 16 },
          blob: { byteLength: 16 }
        }
      })
    }

    createReadStream() {
      return source
    }

    close() {
      return Promise.resolve()
    }
  }

  const transferStore = { replicate() {}, close: () => Promise.resolve() }
  const engine = new TransferEngine({
    store: {
      ready: () => Promise.resolve(),
      session: () => transferStore,
      close: () => Promise.resolve()
    },
    filesystem: {
      promises: { unlink: () => Promise.resolve() },
      createWriteStream: () => output
    },
    path,
    Hyperdrive: FakeHyperdrive,
    createSwarm: () => new LocalOnlySwarm(),
    deadlines: {
      discovery: 100,
      total: 1_000,
      stall: 1_000,
      cleanup: 100,
      shutdown: 100
    }
  })
  t.after(() => engine.close())

  await engine.dispatch({
    type: 'receive.inspect',
    requestId,
    capability: '13'.repeat(32)
  })
  const receiving = engine.dispatch({
    type: 'receive.start',
    requestId,
    destinationPath: '/received.bin'
  })
  setImmediate(() => {
    const error = new Error('disk full')
    error.code = 'ENOSPC'
    output.destroy(error)
  })

  await assert.rejects(receiving, (error) => error.code === 'DESTINATION_UNWRITABLE')
  assert.equal(source.destroyed, true)
  assert.equal(output.destroyed, true)
})

test('sender validation failure is associated with its request before the error', async (t) => {
  const requestId = randomUUID()
  const events = []
  const engine = new TransferEngine({
    store: {
      ready: () => Promise.reject(new Error('store should not open')),
      close: () => Promise.resolve()
    },
    filesystem: {
      promises: {
        stat: () =>
          Promise.resolve({
            size: 25 * 1024 * 1024 + 1,
            mtimeMs: 1,
            isFile: () => true
          })
      }
    },
    path,
    createSwarm: () => new LocalOnlySwarm(),
    deadlines: { cleanup: 100, shutdown: 100 }
  })
  engine.onEvent((event) => events.push(event))
  t.after(() => engine.close())

  await assert.rejects(
    engine.dispatch({ type: 'share.start', requestId, sourcePath: '/large.bin' }),
    (error) => error.code === 'FILE_TOO_LARGE'
  )

  assert.deepEqual(
    events.map((event) => [event.type, event.requestId, event.state || event.error?.code]),
    [
      ['state.changed', requestId, 'preparing'],
      ['state.changed', requestId, 'failed'],
      ['transfer.error', requestId, 'FILE_TOO_LARGE']
    ]
  )
})

test('sender claims the active slot before source inspection completes', async (t) => {
  let resolveFirstStat
  const firstStat = new Promise((resolve) => {
    resolveFirstStat = resolve
  })
  const filesystem = {
    promises: {
      stat(sourcePath) {
        if (sourcePath === '/first.bin') return firstStat
        const error = new Error('second source should not be inspected')
        error.code = 'EACCES'
        return Promise.reject(error)
      }
    }
  }
  const store = {
    ready: () => Promise.reject(new Error('stop after source inspection')),
    close: () => Promise.resolve()
  }
  const engine = new TransferEngine({
    store,
    filesystem,
    path,
    createSwarm: () => new LocalOnlySwarm(),
    deadlines: { cleanup: 100, shutdown: 100 }
  })
  t.after(() => engine.close())

  const firstRequestId = randomUUID()
  const first = engine.dispatch({
    type: 'share.start',
    requestId: firstRequestId,
    sourcePath: '/first.bin'
  })
  first.catch(() => {})
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(engine.snapshot(), {
    mode: 'send',
    state: 'preparing',
    requestId: firstRequestId,
    peers: 0
  })
  await assert.rejects(
    engine.dispatch({
      type: 'share.start',
      requestId: randomUUID(),
      sourcePath: '/second.bin'
    }),
    (error) => error.code === 'BUSY'
  )

  resolveFirstStat({
    size: 1,
    mtimeMs: 1,
    isFile: () => true
  })
  await assert.rejects(first, (error) => error.code === 'INTERNAL')
})

async function waitFor(predicate, timeout) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Timed out waiting for active transfer state.')
}

async function exists(filePath) {
  try {
    await fs.promises.access(filePath)
    return true
  } catch {
    return false
  }
}
