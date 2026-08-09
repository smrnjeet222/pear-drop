const path = require('node:path')

const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron')
const { command, flag } = require('paparam')

const DropController = require('./drop-controller')
const WorkerBroker = require('./worker-broker')
const pkg = require('../package.json')

const cmd = command(
  pkg.productName || pkg.name,
  flag('--storage <dir>', 'use a custom PearDrop storage directory'),
  flag('--no-updates', 'accepted for development compatibility').hide(),
  flag('--no-sandbox', 'start without Chromium sandbox').hide()
)

cmd.parse(app.isPackaged ? process.argv.slice(1) : process.argv.slice(2))

const storageRoot = cmd.flags.storage ? path.resolve(cmd.flags.storage) : app.getPath('userData')

if (cmd.flags.storage) app.setPath('userData', storageRoot)

const workerStorage = path.join(storageRoot, 'app-storage', 'peardrop-corestore')
const workerEntrypoint = require.resolve('../workers/main.js')

const SHUTDOWN_TIMEOUT = 3_000

let controller = null
let quitting = false
let readyToQuit = false
let shutdownPromise = null
let sessionEndPromise = null

function shutdownController() {
  if (shutdownPromise) return shutdownPromise

  let timer
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('PearDrop shutdown deadline exceeded')),
      SHUTDOWN_TIMEOUT
    )
  })
  deadline.catch(() => {})

  shutdownPromise = Promise.race([Promise.resolve().then(() => controller?.shutdown()), deadline])
    .catch((err) => console.error('PearDrop shutdown failed:', err))
    .finally(() => clearTimeout(timer))
  return shutdownPromise
}

function handleSessionEnd(event) {
  event.preventDefault()
  if (sessionEndPromise) return

  sessionEndPromise = shutdownController().finally(() => app.exit(0))
}

function createController() {
  const broker = new WorkerBroker({
    entrypoint: workerEntrypoint,
    storagePath: workerStorage
  })

  return new DropController({
    broker,
    dialog,
    clipboard,
    shell,
    getWindow: (webContents) => BrowserWindow.fromWebContents(webContents)
  })
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 620,
    show: false,
    backgroundColor: '#f4f1e9',
    title: 'PearDrop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  if (process.platform === 'win32') win.on('query-session-end', handleSessionEnd)
  win.once('ready-to-show', () => win.show())
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  return win
}

app.on('before-quit', (event) => {
  if (readyToQuit) return
  event.preventDefault()
  if (quitting) return
  quitting = true

  shutdownController().finally(() => {
    readyToQuit = true
    app.quit()
  })
})

app.whenReady().then(async () => {
  try {
    controller = createController()
    controller.installIpc(ipcMain)
    await controller.start()
    await createWindow()
  } catch (err) {
    console.error('PearDrop failed to start:', err)
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
