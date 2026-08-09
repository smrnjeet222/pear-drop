const assert = require('node:assert/strict')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const FramedStream = require('framed-stream')
const PearRuntime = require('pear-runtime')

const { parseFrame, serializeFrame } = require('../lib/protocol')
const pkg = require('../package.json')

const projectRoot = path.join(__dirname, '..')

async function main() {
  const entrypoint = packagedWorkerEntrypoint()
  assert.ok(fs.existsSync(entrypoint), `Packaged worker not found: ${entrypoint}`)

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peardrop-packaged-worker-'))
  const worker = PearRuntime.run(entrypoint, [path.join(dir, 'store')])
  const pipe = new FramedStream(worker)
  const events = []
  const pipeErrors = []
  let stderr = ''

  pipe.on('data', (frame) => events.push(parseFrame(frame)))
  pipe.on('error', (err) => pipeErrors.push(err))
  worker.stderr.on('data', (data) => {
    stderr += data.toString()
  })

  try {
    await waitFor(
      events,
      (event) => event.type === 'worker.ready',
      5_000,
      () => stderr
    )

    const pipeClosed = once(pipe, 'close')
    const workerExited = once(worker, 'exit')
    const requestId = randomUUID()
    pipe.write(serializeFrame({ v: 1, type: 'worker.shutdown', requestId }))

    await waitFor(
      events,
      (event) => event.type === 'worker.closed',
      3_000,
      () => stderr
    )
    const [, exit] = await within(
      Promise.all([pipeClosed, workerExited]),
      3_000,
      'Packaged worker did not close its pipe and process within 3 seconds.'
    )

    assert.equal(exit[0], 0, `Packaged worker exited with code ${exit[0]}. stderr: ${stderr}`)
    assert.deepEqual(pipeErrors, [])
    assert.equal(stderr, '')
    process.stdout.write(`Packaged worker booted and exited cleanly: ${entrypoint}\n`)
  } finally {
    if (!pipe.destroyed) pipe.destroy()
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}

function packagedWorkerEntrypoint() {
  const packageRoot = path.join(
    projectRoot,
    'out',
    `${pkg.productName || pkg.name}-${process.platform}-${process.arch}`
  )
  const resources =
    process.platform === 'darwin'
      ? path.join(packageRoot, `${pkg.productName || pkg.name}.app`, 'Contents', 'Resources')
      : path.join(packageRoot, 'resources')
  return path.join(resources, 'app', 'workers', 'main.js')
}

async function waitFor(events, predicate, timeout, diagnostics) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const event = events.find(predicate)
    if (event) return event
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for packaged worker event. stderr: ${diagnostics()}`)
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}

module.exports = { main, packagedWorkerEntrypoint }
