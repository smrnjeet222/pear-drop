const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const DropController = require('../electron/drop-controller')

const shareId = '550e8400-e29b-41d4-a716-446655440000'
const receiveId = '550e8400-e29b-41d4-a716-446655440001'

test('drop controller alone authorizes source, destination, and completed output reveal', async () => {
  const broker = new FakeBroker()
  const owner = new FakeWebContents(1)
  const other = new FakeWebContents(2)
  const opened = []
  const copied = []
  const ids = [shareId, receiveId]
  const dialog = {
    async showOpenDialog() {
      return { canceled: false, filePaths: ['/private/source.bin'] }
    },
    async showSaveDialog() {
      return { canceled: false, filePath: '/private/received.bin' }
    }
  }
  const controller = new DropController({
    broker,
    dialog,
    clipboard: { writeText: (value) => copied.push(value) },
    shell: {
      showItemInFolder(filePath) {
        opened.push(filePath)
      }
    },
    randomUUID: () => ids.shift(),
    getWindow: () => null
  })

  await controller.start()

  const shared = await controller.chooseAndShare(owner)
  assert.equal(shared.requestId, shareId)
  assert.deepEqual(broker.commands.at(-1), {
    type: 'share.start',
    requestId: shareId,
    fields: { sourcePath: '/private/source.bin' }
  })

  broker.current = {
    mode: 'send',
    state: 'sharing',
    requestId: shareId,
    capability: 'ab'.repeat(32)
  }
  await controller.copyCapability(owner, shareId)
  assert.deepEqual(copied, ['ab'.repeat(32)])

  await assert.rejects(controller.cancel(other, shareId), (err) => err.code === 'INVALID_STATE')

  broker.current = { mode: null, state: 'idle', requestId: null }
  const receiving = await controller.receive(owner, 'cd'.repeat(32))
  assert.equal(receiving.requestId, receiveId)
  assert.deepEqual(broker.commands.at(-1), {
    type: 'receive.inspect',
    requestId: receiveId,
    fields: { capability: 'cd'.repeat(32) }
  })

  broker.emitEvent({
    v: 1,
    type: 'receive.metadata',
    requestId: receiveId,
    file: { name: 'source.bin', size: 12 }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(broker.commands.at(-1), {
    type: 'receive.start',
    requestId: receiveId,
    fields: { destinationPath: '/private/received.bin' }
  })

  broker.emitEvent({
    v: 1,
    type: 'state.changed',
    requestId: receiveId,
    mode: 'receive',
    state: 'completed',
    file: { name: 'source.bin', size: 12 },
    bytes: { transferred: 12, total: 12 },
    peers: 0
  })

  const completed = owner.messages.at(-1)
  assert.equal(completed.channel, 'peardrop:event')
  assert.equal(completed.data.outputPath, '/private/received.bin')

  await controller.openReceived(owner, receiveId)
  assert.deepEqual(opened, ['/private/received.bin'])

  await controller.shutdown()
})

test('renderer navigation preserves ownership of an active share', async () => {
  const broker = new FakeBroker()
  const owner = new FakeWebContents(1)
  const copied = []
  const controller = new DropController({
    broker,
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/private/source.bin'] })
    },
    clipboard: { writeText: (value) => copied.push(value) },
    shell: { showItemInFolder() {} },
    randomUUID: () => shareId,
    getWindow: () => null
  })

  await controller.start()
  await controller.chooseAndShare(owner)
  broker.current = {
    mode: 'send',
    state: 'sharing',
    requestId: shareId,
    capability: 'ab'.repeat(32)
  }

  owner.emit('did-start-navigation')
  await controller.copyCapability(owner, shareId)
  await controller.cancel(owner, shareId)

  assert.deepEqual(copied, ['ab'.repeat(32)])
  assert.deepEqual(broker.commands.at(-1), {
    type: 'transfer.cancel',
    requestId: shareId,
    fields: {}
  })
  await controller.shutdown()
})

test('renderer navigation preserves terminal reset but clears completed output access', async () => {
  const broker = new FakeBroker()
  const owner = new FakeWebContents(1)
  const controller = new DropController({
    broker,
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: '/private/received.bin' })
    },
    clipboard: { writeText() {} },
    shell: { showItemInFolder() {} },
    randomUUID: () => receiveId,
    getWindow: () => null
  })

  await controller.start()
  await controller.receive(owner, 'cd'.repeat(32))
  broker.emitEvent({
    v: 1,
    type: 'receive.metadata',
    requestId: receiveId,
    file: { name: 'source.bin', size: 12 }
  })
  await new Promise((resolve) => setImmediate(resolve))
  broker.current = {
    mode: 'receive',
    state: 'completed',
    requestId: receiveId,
    file: { name: 'source.bin', size: 12 },
    bytes: { transferred: 12, total: 12 },
    peers: 0
  }
  broker.emitEvent({ v: 1, type: 'state.changed', ...broker.current })

  assert.equal(controller.getSnapshot(owner).outputPath, '/private/received.bin')
  owner.emit('did-start-navigation')

  assert.equal('outputPath' in controller.getSnapshot(owner), false)
  await assert.rejects(
    Promise.resolve().then(() => controller.openReceived(owner, receiveId)),
    (error) => error.code === 'INVALID_STATE'
  )
  await controller.reset(owner, receiveId)
  assert.deepEqual(broker.commands.at(-1), {
    type: 'transfer.reset',
    requestId: receiveId,
    fields: {}
  })
  await controller.shutdown()
})

test('renderer navigation cancels an active receive without dropping its idle event', async () => {
  const broker = new FakeBroker()
  const owner = new FakeWebContents(1)
  const controller = new DropController({
    broker,
    dialog: {},
    clipboard: { writeText() {} },
    shell: { showItemInFolder() {} },
    randomUUID: () => receiveId,
    getWindow: () => null
  })

  await controller.start()
  await controller.receive(owner, 'cd'.repeat(32))
  broker.current = { mode: 'receive', state: 'discovering', requestId: receiveId }
  owner.emit('did-start-navigation')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(broker.commands.at(-1), {
    type: 'transfer.cancel',
    requestId: receiveId,
    fields: {}
  })
  broker.current = { mode: null, state: 'idle', requestId: null }
  broker.emitEvent({
    v: 1,
    type: 'state.changed',
    requestId: receiveId,
    mode: null,
    state: 'idle'
  })
  assert.equal(owner.messages.at(-1).data.state, 'idle')
  await controller.shutdown()
})

class FakeBroker {
  constructor() {
    this.listeners = new Set()
    this.commands = []
    this.current = { mode: null, state: 'idle', requestId: null }
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start() {
    return this.current
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.current))
  }

  async command(type, requestId, fields = {}) {
    this.commands.push({ type, requestId, fields })
    return { type: 'command.accepted', requestId, command: type }
  }

  emitEvent(event) {
    for (const listener of this.listeners) listener(event)
  }

  async shutdown() {}
}

class FakeWebContents extends EventEmitter {
  constructor(id) {
    super()
    this.id = id
    this.messages = []
    this.destroyed = false
  }

  isDestroyed() {
    return this.destroyed
  }

  send(channel, data) {
    this.messages.push({ channel, data })
  }
}
