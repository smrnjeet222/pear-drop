const test = require('node:test')
const assert = require('node:assert/strict')
const { randomBytes, randomUUID } = require('node:crypto')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const b4a = require('b4a')
const FramedStream = require('framed-stream')
const PearRuntime = require('pear-runtime')

const { parseFrame, serializeFrame } = require('../../lib/protocol')

test(
  'Bare worker rejects bad input, streams a path, and exits cleanly from an active transfer',
  { timeout: 32_000 },
  async (t) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peardrop-worker-'))
    const sourcePath = path.join(dir, 'source.bin')
    await fs.promises.writeFile(sourcePath, b4a.alloc(256 * 1024, 0x2a))

    const worker = PearRuntime.run(require.resolve('../../workers/main.js'), [
      path.join(dir, 'store')
    ])
    const pipe = new FramedStream(worker)
    const events = []
    let stderr = ''

    pipe.on('data', (frame) => events.push(parseFrame(frame)))
    pipe.on('error', () => {})
    worker.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    t.after(async () => {
      if (!pipe.destroyed) pipe.destroy()
      await fs.promises.rm(dir, { recursive: true, force: true })
    })

    await waitFor(
      events,
      (event) => event.type === 'worker.ready',
      5_000,
      () => stderr
    )

    const malformedRequestId = randomUUID()
    pipe.write(
      b4a.from(
        JSON.stringify({
          v: 1,
          type: 'state.get',
          requestId: malformedRequestId,
          unexpected: true
        })
      )
    )
    const malformedError = await waitFor(
      events,
      (event) => event.type === 'transfer.error' && event.requestId === malformedRequestId,
      3_000,
      () => stderr
    )
    assert.deepEqual(malformedError.error, {
      code: 'INVALID_FRAME',
      message: 'Worker command was rejected.',
      retryable: false
    })
    await delay(50)
    assert.equal(
      events.filter(
        (event) => event.type === 'transfer.error' && event.requestId === malformedRequestId
      ).length,
      1
    )
    assert.equal(
      events.some(
        (event) => event.type === 'command.accepted' && event.requestId === malformedRequestId
      ),
      false
    )

    const invalidRequestId = randomUUID()
    const invalidStarted = Date.now()
    pipe.write(
      serializeFrame({
        v: 1,
        type: 'receive.inspect',
        requestId: invalidRequestId,
        capability: 'not-a-capability'
      })
    )
    const invalidError = await waitFor(
      events,
      (event) => event.type === 'transfer.error' && event.requestId === invalidRequestId,
      1_000,
      () => stderr
    )
    assert.equal(invalidError.error.code, 'INVALID_CAPABILITY')
    assert.equal(invalidError.error.message, "Paste the sender's 64-character PearDrop key.")
    assert.ok(Date.now() - invalidStarted < 1_000)
    await delay(50)
    assert.equal(
      events.filter(
        (event) => event.type === 'transfer.error' && event.requestId === invalidRequestId
      ).length,
      1
    )
    assert.equal(
      events.some(
        (event) =>
          event.requestId === invalidRequestId &&
          (event.type === 'receive.metadata' || event.state === 'completed')
      ),
      false
    )

    const unavailableRequestId = randomUUID()
    const unavailableStarted = Date.now()
    pipe.write(
      serializeFrame({
        v: 1,
        type: 'receive.inspect',
        requestId: unavailableRequestId,
        capability: b4a.toString(randomBytes(32), 'hex')
      })
    )
    const unavailableError = await waitFor(
      events,
      (event) => event.type === 'transfer.error' && event.requestId === unavailableRequestId,
      16_000,
      () => stderr
    )
    assert.equal(unavailableError.error.code, 'SENDER_UNAVAILABLE')
    assert.equal(
      unavailableError.error.message,
      'Keep the sender online, verify the key, and retry.'
    )
    assert.ok(Date.now() - unavailableStarted < 16_000)
    await delay(50)
    assert.equal(
      events.filter(
        (event) => event.type === 'transfer.error' && event.requestId === unavailableRequestId
      ).length,
      1
    )
    assert.equal(
      events.some(
        (event) =>
          event.requestId === unavailableRequestId &&
          (event.type === 'receive.metadata' || event.state === 'completed')
      ),
      false
    )

    pipe.write(serializeFrame({ v: 1, type: 'transfer.reset', requestId: unavailableRequestId }))
    await waitFor(
      events,
      (event) =>
        event.type === 'state.changed' &&
        event.requestId === unavailableRequestId &&
        event.state === 'idle',
      3_000,
      () => stderr
    )

    const stateRequestId = randomUUID()
    pipe.write(serializeFrame({ v: 1, type: 'state.get', requestId: stateRequestId }))
    await waitFor(
      events,
      (event) =>
        event.type === 'command.accepted' &&
        event.requestId === stateRequestId &&
        event.command === 'state.get',
      3_000,
      () => stderr
    )

    const shareRequestId = randomUUID()
    pipe.write(
      serializeFrame({
        v: 1,
        type: 'share.start',
        requestId: shareRequestId,
        sourcePath
      })
    )
    await waitFor(
      events,
      (event) =>
        event.type === 'transfer.progress' &&
        event.requestId === shareRequestId &&
        event.transferred === 256 * 1024,
      5_000,
      () => stderr
    )

    assert.notEqual(
      events.find((event) => event.type === 'state.changed' && event.requestId === shareRequestId)
        ?.state,
      'idle'
    )

    const pipeClosed = once(pipe, 'close')
    const workerExited = once(worker, 'exit')
    const shutdownRequestId = randomUUID()
    const shutdownStarted = Date.now()
    pipe.write(serializeFrame({ v: 1, type: 'worker.shutdown', requestId: shutdownRequestId }))
    await waitFor(
      events,
      (event) => event.type === 'worker.closed',
      3_000,
      () => stderr
    )
    const workerClosedElapsed = Date.now() - shutdownStarted
    if (!pipe.destroyed) pipe.destroy()
    const [, exit] = await within(
      Promise.all([pipeClosed, workerExited]),
      3_000,
      'Worker did not close its pipe and process within 3 seconds.'
    )

    const shutdownElapsed = Date.now() - shutdownStarted
    assert.ok(
      shutdownElapsed < 3_000,
      `Worker closed event took ${workerClosedElapsed} ms; process exit took ${shutdownElapsed} ms.`
    )
    assert.ok(exit[0] === 0 || typeof exit[1] === 'string')
    assert.equal(stderr, '')
  }
)

async function waitFor(events, predicate, timeout, diagnostics) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const event = events.find(predicate)
    if (event) return event
    await delay(10)
  }

  assert.fail(`Timed out waiting for worker event. stderr: ${diagnostics()}`)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function within(promise, timeout, message) {
  let timer
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}
