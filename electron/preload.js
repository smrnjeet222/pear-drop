const { contextBridge, ipcRenderer } = require('electron')

const CHANNELS = {
  getSnapshot: 'peardrop:get-snapshot',
  chooseAndShare: 'peardrop:choose-and-share',
  receive: 'peardrop:receive',
  cancel: 'peardrop:cancel',
  reset: 'peardrop:reset',
  copyCapability: 'peardrop:copy-capability',
  openReceived: 'peardrop:open-received',
  event: 'peardrop:event'
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requireRequestId(requestId) {
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
    throw new TypeError('requestId must be a UUID')
  }
  return requestId
}

function invokeForRequest(channel, requestId) {
  return ipcRenderer.invoke(channel, requireRequestId(requestId))
}

const peardrop = {
  getSnapshot() {
    return ipcRenderer.invoke(CHANNELS.getSnapshot)
  },
  chooseAndShare() {
    return ipcRenderer.invoke(CHANNELS.chooseAndShare)
  },
  receive(capability) {
    if (typeof capability !== 'string') throw new TypeError('capability must be a string')
    return ipcRenderer.invoke(CHANNELS.receive, capability)
  },
  cancel(requestId) {
    return invokeForRequest(CHANNELS.cancel, requestId)
  },
  reset(requestId) {
    return invokeForRequest(CHANNELS.reset, requestId)
  },
  copyCapability(requestId) {
    return invokeForRequest(CHANNELS.copyCapability, requestId)
  },
  openReceived(requestId) {
    return invokeForRequest(CHANNELS.openReceived, requestId)
  },
  onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    const wrapped = (_event, message) => listener(message)
    ipcRenderer.on(CHANNELS.event, wrapped)
    return () => ipcRenderer.removeListener(CHANNELS.event, wrapped)
  }
}

contextBridge.exposeInMainWorld('peardrop', Object.freeze(peardrop))
