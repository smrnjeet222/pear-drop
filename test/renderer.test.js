const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const rendererPath = path.join(__dirname, '..', 'renderer', 'app.js')
const rendererSource = fs.readFileSync(rendererPath, 'utf8')
const requestId = '550e8400-e29b-41d4-a716-446655440001'
const rendererHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8')

test('renderer progress indicators use their visible labels as accessible names', () => {
  assert.match(
    rendererHtml,
    /<progress\s+id="send-progress"\s+aria-labelledby="send-progress-label"/
  )
  assert.match(
    rendererHtml,
    /<progress\s+id="receive-progress"\s+aria-labelledby="receive-progress-label"/
  )
})

test('renderer shows invalid-key guidance, progress, and an enabled received-file reveal', async () => {
  const elements = new Map()
  const opened = []
  let onEvent

  const api = {
    getSnapshot: () => Promise.resolve({ mode: null, state: 'idle', requestId: null }),
    chooseAndShare: () => Promise.resolve(),
    receive: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    reset: () => Promise.resolve(),
    copyCapability: () => Promise.resolve(),
    openReceived: (id) => {
      opened.push(id)
      return Promise.resolve(true)
    },
    onEvent(listener) {
      onEvent = listener
      return () => {}
    }
  }
  const window = {
    peardrop: api,
    addEventListener() {}
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement())
      return elements.get(id)
    }
  }

  vm.runInNewContext(rendererSource, {
    clearTimeout,
    document,
    setTimeout,
    window
  })
  await turn()

  onEvent({
    v: 1,
    type: 'transfer.error',
    requestId,
    error: {
      code: 'INVALID_CAPABILITY',
      message: "Paste the sender's 64-character PearDrop key.",
      retryable: false
    }
  })
  assert.equal(elements.get('action-error').hidden, false)
  assert.equal(
    elements.get('action-error-message').textContent,
    "Paste the sender's 64-character PearDrop key."
  )
  assert.equal(elements.get('capability-input').attributes.get('aria-invalid'), 'true')
  assert.equal(elements.get('capability-input').focused, true)

  onEvent({
    v: 1,
    type: 'state.changed',
    requestId,
    mode: 'receive',
    state: 'transferring',
    file: { name: 'fixture.bin', size: 1_000 },
    bytes: { transferred: 0, total: 1_000 },
    peers: 1
  })
  onEvent({
    v: 1,
    type: 'transfer.progress',
    requestId,
    phase: 'transferring',
    transferred: 400,
    total: 1_000
  })
  assert.equal(elements.get('receive-progress-block').hidden, false)
  assert.equal(elements.get('receive-progress').value, 40)
  assert.equal(elements.get('receive-progress-value').textContent, '40%')
  assert.equal(elements.get('receive-bytes').textContent, '400 B of 1000 B')

  onEvent({
    v: 1,
    type: 'state.changed',
    requestId,
    mode: 'receive',
    state: 'completed',
    file: { name: 'fixture.bin', size: 1_000 },
    bytes: { transferred: 1_000, total: 1_000 },
    peers: 0,
    outputPath: '/private/received.bin'
  })
  assert.equal(elements.get('completion-block').hidden, false)
  assert.equal(elements.get('output-path').textContent, '/private/received.bin')
  assert.equal(elements.get('open-received').disabled, false)

  await elements.get('open-received').listeners.get('click')()
  assert.deepEqual(opened, [requestId])
})

test('renderer keeps sender validation errors out of the receiver key field', async () => {
  const { elements, onEvent } = await createRendererHarness()

  onEvent({
    v: 1,
    type: 'state.changed',
    requestId,
    mode: 'send',
    state: 'preparing',
    peers: 0
  })
  onEvent({
    v: 1,
    type: 'state.changed',
    requestId,
    mode: 'send',
    state: 'failed',
    peers: 0
  })
  onEvent({
    v: 1,
    type: 'transfer.error',
    requestId,
    error: {
      code: 'FILE_TOO_LARGE',
      message: 'Choose a file no larger than 25 MB.',
      retryable: false
    }
  })

  assert.equal(elements.get('send-error').hidden, false)
  assert.equal(elements.get('send-error-message').textContent, 'Choose a file no larger than 25 MB.')
  assert.equal(elements.get('action-error').hidden, true)
  assert.equal(elements.get('capability-input').attributes.has('aria-invalid'), false)
  assert.equal(elements.get('capability-input').focused, false)
})

test('renderer makes worker crashes persistent and disables transfer controls', async () => {
  const elements = new Map()
  let onEvent
  const api = {
    getSnapshot: () => Promise.resolve({ mode: null, state: 'idle', requestId: null }),
    chooseAndShare: () => Promise.resolve(),
    receive: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    reset: () => Promise.resolve(),
    copyCapability: () => Promise.resolve(),
    openReceived: () => Promise.resolve(),
    onEvent(listener) {
      onEvent = listener
      return () => {}
    }
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement())
      return elements.get(id)
    }
  }

  vm.runInNewContext(rendererSource, {
    clearTimeout,
    document,
    setTimeout,
    window: { peardrop: api, addEventListener() {} }
  })
  await turn()

  onEvent({
    v: 1,
    type: 'state.changed',
    requestId,
    mode: 'send',
    state: 'sharing',
    file: { name: 'fixture.bin', size: 1_000 },
    capability: 'ab'.repeat(32),
    peers: 0
  })
  onEvent({
    v: 1,
    type: 'transfer.error',
    requestId,
    error: {
      code: 'WORKER_CRASHED',
      message: 'PearDrop worker stopped. Restart the app.',
      retryable: true
    }
  })

  assert.equal(elements.get('send-error').hidden, false)
  assert.equal(
    elements.get('send-error-message').textContent,
    'PearDrop worker stopped. Restart the app.'
  )
  assert.equal(elements.get('stop-sharing').hidden, true)
  assert.equal(elements.get('reset-send').hidden, false)
  assert.equal(elements.get('reset-send').disabled, true)
  assert.equal(elements.get('copy-capability').disabled, true)
})

class FakeElement {
  constructor() {
    this.attributes = new Map()
    this.child = null
    this.classList = { toggle() {} }
    this.disabled = false
    this.focused = false
    this.hidden = false
    this.listeners = new Map()
    this.textContent = ''
    this.value = ''
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener)
  }

  focus() {
    this.focused = true
  }

  querySelector() {
    if (!this.child) this.child = new FakeElement()
    return this.child
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  setAttribute(name, value) {
    this.attributes.set(name, value)
  }
}

async function createRendererHarness() {
  const elements = new Map()
  let onEvent
  const api = {
    getSnapshot: () => Promise.resolve({ mode: null, state: 'idle', requestId: null }),
    chooseAndShare: () => Promise.resolve(),
    receive: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    reset: () => Promise.resolve(),
    copyCapability: () => Promise.resolve(),
    openReceived: () => Promise.resolve(),
    onEvent(listener) {
      onEvent = listener
      return () => {}
    }
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement())
      return elements.get(id)
    }
  }

  vm.runInNewContext(rendererSource, {
    clearTimeout,
    document,
    setTimeout,
    window: { peardrop: api, addEventListener() {} }
  })
  await turn()
  return { elements, onEvent }
}

function turn() {
  return new Promise((resolve) => setImmediate(resolve))
}
