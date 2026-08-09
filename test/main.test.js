const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const mainPath = path.join(__dirname, '..', 'electron', 'main.js')
const mainSource = fs.readFileSync(mainPath, 'utf8')

test('main routes separate --storage roots to separate fixed worker stores', async () => {
  const firstRoot = path.resolve('/tmp/peardrop-main-a')
  const secondRoot = path.resolve('/tmp/peardrop-main-b')
  const first = await loadMain({ storageRoot: firstRoot })
  const second = await loadMain({ storageRoot: secondRoot })

  assert.equal(first.app.paths.userData, firstRoot)
  assert.equal(second.app.paths.userData, secondRoot)
  assert.deepEqual(first.brokers[0], {
    entrypoint: path.join(__dirname, '..', 'workers', 'main.js'),
    storagePath: path.join(firstRoot, 'app-storage', 'peardrop-corestore')
  })
  assert.deepEqual(second.brokers[0], {
    entrypoint: path.join(__dirname, '..', 'workers', 'main.js'),
    storagePath: path.join(secondRoot, 'app-storage', 'peardrop-corestore')
  })
  assert.notEqual(first.brokers[0].storagePath, second.brokers[0].storagePath)
})

test('main waits for one controller shutdown during normal quit', async () => {
  const shutdown = deferred()
  const harness = await loadMain({ shutdown: () => shutdown.promise })
  const event = preventableEvent()

  harness.app.emit('before-quit', event)
  harness.app.emit('before-quit', event)
  await turn()

  assert.equal(event.prevented, 2)
  assert.equal(harness.shutdownCalls(), 1)
  assert.equal(harness.app.quitCalls, 0)

  shutdown.resolve()
  await turn()
  assert.equal(harness.app.quitCalls, 1)
})

test('Windows session end waits for the same bounded shutdown before exiting', async () => {
  const harness = await loadMain({
    platform: 'win32',
    shutdown: () => new Promise(() => {}),
    shortenShutdownTimer: true
  })
  const event = preventableEvent()

  harness.windows[0].emit('query-session-end', event)
  harness.windows[0].emit('query-session-end', event)
  await turn()

  assert.equal(event.prevented, 2)
  assert.equal(harness.shutdownCalls(), 1)
  assert.deepEqual(harness.app.exitCodes, [])
  assert.ok(harness.timeoutDelays.includes(3_000))

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(harness.app.exitCodes, [0])
  assert.match(String(harness.errors[0][1]), /shutdown deadline exceeded/)
})

async function loadMain(options = {}) {
  const app = new EventEmitter()
  const storageRoot = options.storageRoot || path.resolve('/tmp/peardrop-main-default')
  const brokers = []
  const windows = []
  const timeoutDelays = []
  const errors = []
  let controllerShutdownCalls = 0

  app.isPackaged = false
  app.paths = { userData: path.resolve('/tmp/peardrop-default-user-data') }
  app.getPath = (name) => app.paths[name]
  app.setPath = (name, value) => {
    app.paths[name] = value
  }
  app.whenReady = () => Promise.resolve()
  app.quitCalls = 0
  app.quit = () => {
    app.quitCalls += 1
  }
  app.exitCodes = []
  app.exit = (code) => app.exitCodes.push(code)

  class BrowserWindow extends EventEmitter {
    constructor(settings) {
      super()
      this.settings = settings
      this.webContents = { id: windows.length + 1 }
      windows.push(this)
    }

    show() {}

    loadFile() {
      return Promise.resolve()
    }

    static fromWebContents() {
      return null
    }
  }

  class FakeBroker {
    constructor(settings) {
      brokers.push(settings)
    }
  }

  class FakeController {
    installIpc() {}

    start() {
      return Promise.resolve()
    }

    shutdown() {
      controllerShutdownCalls += 1
      return options.shutdown ? options.shutdown() : Promise.resolve()
    }
  }

  const fakeRequire = (specifier) => {
    if (specifier === 'electron') {
      return {
        app,
        BrowserWindow,
        clipboard: {},
        dialog: {},
        ipcMain: {},
        shell: {}
      }
    }
    if (specifier === './drop-controller') return FakeController
    if (specifier === './worker-broker') return FakeBroker
    if (specifier === '../package.json') return require('../package.json')
    return require(specifier)
  }
  fakeRequire.resolve = (specifier) => {
    if (specifier === '../workers/main.js') {
      return path.join(__dirname, '..', 'workers', 'main.js')
    }
    return require.resolve(specifier)
  }

  const nativeSetTimeout = setTimeout
  const sandbox = {
    __dirname: path.dirname(mainPath),
    __filename: mainPath,
    clearTimeout,
    console: {
      error(...args) {
        errors.push(args)
      },
      log() {}
    },
    exports: {},
    module: { exports: {} },
    process: {
      argv: ['electron', mainPath, '--storage', storageRoot],
      platform: options.platform || 'darwin'
    },
    require: fakeRequire,
    setTimeout(callback, milliseconds) {
      timeoutDelays.push(milliseconds)
      return nativeSetTimeout(
        callback,
        options.shortenShutdownTimer && milliseconds === 3_000 ? 5 : milliseconds
      )
    }
  }

  vm.runInNewContext(mainSource, sandbox, { filename: mainPath })
  await turn()
  await turn()

  return {
    app,
    brokers: JSON.parse(JSON.stringify(brokers)),
    errors,
    shutdownCalls: () => controllerShutdownCalls,
    timeoutDelays,
    windows
  }
}

function preventableEvent() {
  return {
    prevented: 0,
    preventDefault() {
      this.prevented += 1
    }
  }
}

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function turn() {
  return new Promise((resolve) => setImmediate(resolve))
}
