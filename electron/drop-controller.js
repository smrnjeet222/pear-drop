const { randomUUID } = require('node:crypto')

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

class DropController {
  constructor(options = {}) {
    if (!options.broker) throw new TypeError('worker broker is required')
    if (!options.dialog) throw new TypeError('dialog adapter is required')
    if (!options.clipboard) throw new TypeError('clipboard adapter is required')
    if (!options.shell) throw new TypeError('shell adapter is required')

    this.broker = options.broker
    this.dialog = options.dialog
    this.clipboard = options.clipboard
    this.shell = options.shell
    this.randomUUID = options.randomUUID || randomUUID
    this.getWindow = options.getWindow || (() => null)
    this.log = options.log || console

    this.requests = new Map()
    this.allowedOutputs = new Map()
    this.owners = new Map()
    this.ipcMain = null
    this.handlers = new Map()
    this.unsubscribe = null
    this.started = false
    this.closing = false
  }

  async start() {
    if (this.started) return this.getSnapshot()
    this.unsubscribe = this.broker.onEvent((event) => this._onWorkerEvent(event))
    await this.broker.start()
    this.started = true
    return this.getSnapshot()
  }

  installIpc(ipcMain) {
    if (this.ipcMain) throw new Error('PearDrop IPC handlers are already installed')
    this.ipcMain = ipcMain

    this._handle(CHANNELS.getSnapshot, (event) => this.getSnapshot(event.sender))
    this._handle(CHANNELS.chooseAndShare, (event) => this.chooseAndShare(event.sender))
    this._handle(CHANNELS.receive, (event, capability) => {
      return this.receive(event.sender, capability)
    })
    this._handle(CHANNELS.cancel, (event, requestId) => {
      return this.cancel(event.sender, requestId)
    })
    this._handle(CHANNELS.reset, (event, requestId) => {
      return this.reset(event.sender, requestId)
    })
    this._handle(CHANNELS.copyCapability, (event, requestId) => {
      return this.copyCapability(event.sender, requestId)
    })
    this._handle(CHANNELS.openReceived, (event, requestId) => {
      return this.openReceived(event.sender, requestId)
    })
  }

  getSnapshot(owner) {
    const snapshot = clone(this.broker.snapshot())
    if (!owner || !snapshot.requestId) return snapshot

    const allowed = this.allowedOutputs.get(snapshot.requestId)
    if (allowed && allowed.ownerId === owner.id) snapshot.outputPath = allowed.path
    return snapshot
  }

  async chooseAndShare(owner) {
    this._assertOwner(owner)
    const result = await this._showOpenDialog(owner)
    if (result.canceled || result.filePaths.length === 0) {
      return { cancelled: true, snapshot: this.getSnapshot(owner) }
    }

    const requestId = this.randomUUID()
    const context = this._rememberRequest(requestId, owner, 'send')
    try {
      await this.broker.command('share.start', requestId, {
        sourcePath: result.filePaths[0]
      })
      return { requestId }
    } catch (err) {
      this._forgetRequest(context)
      throw err
    }
  }

  async receive(owner, capability) {
    this._assertOwner(owner)
    const requestId = this.randomUUID()
    const context = this._rememberRequest(requestId, owner, 'receive')
    try {
      await this.broker.command('receive.inspect', requestId, { capability })
      return { requestId }
    } catch (err) {
      this._forgetRequest(context)
      throw err
    }
  }

  async cancel(owner, requestId) {
    this._ownedRequest(owner, requestId)
    await this.broker.command('transfer.cancel', requestId)
    return { requestId }
  }

  async reset(owner, requestId) {
    this._ownedRequest(owner, requestId)
    await this.broker.command('transfer.reset', requestId)
    return { requestId }
  }

  async copyCapability(owner, requestId) {
    this._ownedRequest(owner, requestId)
    const snapshot = this.broker.snapshot()
    if (snapshot.requestId !== requestId || typeof snapshot.capability !== 'string') {
      throw controllerError('INVALID_STATE')
    }
    this.clipboard.writeText(snapshot.capability)
    return true
  }

  openReceived(owner, requestId) {
    this._ownedRequest(owner, requestId)
    const allowed = this.allowedOutputs.get(requestId)
    if (!allowed || allowed.ownerId !== owner.id) throw controllerError('INVALID_STATE')

    try {
      this.shell.showItemInFolder(allowed.path)
    } catch (err) {
      throw controllerError('OPEN_FAILED', err?.message)
    }
    return true
  }

  async shutdown() {
    if (this.closing) return
    this.closing = true

    if (this.unsubscribe) this.unsubscribe()
    this.unsubscribe = null
    this._removeIpc()

    for (const owner of this.owners.values()) this._removeOwnerListeners(owner)
    this.owners.clear()
    this.requests.clear()
    this.allowedOutputs.clear()

    await this.broker.shutdown()
  }

  _handle(channel, handler) {
    this.handlers.set(channel, handler)
    this.ipcMain.handle(channel, handler)
  }

  _removeIpc() {
    if (!this.ipcMain) return
    for (const channel of this.handlers.keys()) this.ipcMain.removeHandler(channel)
    this.handlers.clear()
    this.ipcMain = null
  }

  _rememberRequest(requestId, owner, mode) {
    const context = {
      requestId,
      owner,
      ownerId: owner.id,
      mode,
      choosingDestination: false,
      navigationCancelled: false,
      destinationPath: null
    }
    this.requests.set(requestId, context)
    this._watchOwner(owner)
    return context
  }

  _forgetRequest(context) {
    if (this.requests.get(context.requestId) === context) this.requests.delete(context.requestId)
    this.allowedOutputs.delete(context.requestId)
  }

  _ownedRequest(owner, requestId) {
    this._assertOwner(owner)
    const context = this.requests.get(requestId)
    if (!context || context.ownerId !== owner.id) throw controllerError('INVALID_STATE')
    return context
  }

  _watchOwner(owner) {
    if (this.owners.has(owner.id)) return

    const onDestroyed = () => this._cleanupOwner(owner)
    const onNavigation = () => this._handleNavigation(owner)
    const record = { owner, onDestroyed, onNavigation }
    this.owners.set(owner.id, record)
    owner.once?.('destroyed', onDestroyed)
    owner.on?.('did-start-navigation', onNavigation)
  }

  _removeOwnerListeners(record) {
    record.owner.removeListener?.('destroyed', record.onDestroyed)
    record.owner.removeListener?.('did-start-navigation', record.onNavigation)
  }

  _handleNavigation(owner) {
    const snapshot = this.broker.snapshot()
    for (const context of this.requests.values()) {
      if (context.ownerId !== owner.id) continue
      if (
        context.mode === 'receive' &&
        snapshot.requestId === context.requestId &&
        !['idle', 'failed', 'completed'].includes(snapshot.state) &&
        !context.navigationCancelled
      ) {
        context.navigationCancelled = true
        this.broker
          .command('transfer.cancel', context.requestId)
          .catch((err) => this.log.error?.(err))
      }
    }

    for (const [requestId, allowed] of this.allowedOutputs) {
      if (allowed.ownerId === owner.id) this.allowedOutputs.delete(requestId)
    }
  }

  _cleanupOwner(owner) {
    const record = this.owners.get(owner.id)
    if (record) this._removeOwnerListeners(record)
    this.owners.delete(owner.id)

    const snapshot = this.broker.snapshot()
    for (const context of [...this.requests.values()]) {
      if (context.ownerId !== owner.id) continue

      if (
        context.mode === 'receive' &&
        snapshot.requestId === context.requestId &&
        !['idle', 'failed', 'completed'].includes(snapshot.state)
      ) {
        this.broker
          .command('transfer.cancel', context.requestId)
          .catch((err) => this.log.error?.(err))
      }
      this._forgetRequest(context)
    }

    for (const [requestId, allowed] of this.allowedOutputs) {
      if (allowed.ownerId === owner.id) this.allowedOutputs.delete(requestId)
    }
  }

  _onWorkerEvent(event) {
    const context = event.requestId ? this.requests.get(event.requestId) : null
    if (!context) return

    if (event.type === 'receive.metadata') {
      this._forward(context, event)
      this._chooseDestination(context, event.file).catch((err) => {
        this.log.error?.(err)
        if (this.requests.get(context.requestId) !== context) return
        this.broker
          .command('transfer.cancel', context.requestId)
          .catch((cancelError) => this.log.error?.(cancelError))
      })
      return
    }

    if (event.type === 'state.changed' && event.state === 'completed') {
      if (context.destinationPath) {
        this.allowedOutputs.set(context.requestId, {
          ownerId: context.ownerId,
          path: context.destinationPath
        })
      }
      const outputPath = this.allowedOutputs.get(context.requestId)?.path
      this._forward(context, outputPath ? { ...event, outputPath } : event)
      return
    }

    this._forward(context, event)

    if (event.type === 'transfer.error' && this.broker.snapshot().state === 'idle') {
      this._forgetRequest(context)
    } else if (event.type === 'state.changed' && event.state === 'idle') {
      this._forgetRequest(context)
    }
  }

  async _chooseDestination(context, file) {
    if (
      context.choosingDestination ||
      context.navigationCancelled ||
      this.requests.get(context.requestId) !== context
    ) {
      return
    }
    context.choosingDestination = true

    const result = await this._showSaveDialog(context.owner, file.name)
    if (
      this.requests.get(context.requestId) !== context ||
      context.navigationCancelled ||
      !this._ownerAvailable(context.owner)
    ) {
      return
    }

    if (result.canceled || !result.filePath) {
      await this.broker.command('transfer.cancel', context.requestId)
      return
    }

    context.destinationPath = result.filePath
    await this.broker.command('receive.start', context.requestId, {
      destinationPath: result.filePath
    })
  }

  _forward(context, event) {
    if (!this._ownerAvailable(context.owner)) return
    context.owner.send(CHANNELS.event, clone(event))
  }

  _showOpenDialog(owner) {
    const options = { properties: ['openFile'] }
    const window = this.getWindow(owner)
    return window
      ? this.dialog.showOpenDialog(window, options)
      : this.dialog.showOpenDialog(options)
  }

  _showSaveDialog(owner, defaultPath) {
    const options = { defaultPath }
    const window = this.getWindow(owner)
    return window
      ? this.dialog.showSaveDialog(window, options)
      : this.dialog.showSaveDialog(options)
  }

  _assertOwner(owner) {
    if (!this._ownerAvailable(owner)) throw controllerError('INVALID_STATE')
  }

  _ownerAvailable(owner) {
    return !!owner && typeof owner.id === 'number' && !owner.isDestroyed?.()
  }
}

function controllerError(code, detail) {
  const messages = {
    INVALID_STATE: 'Finish or cancel the current handoff first.',
    OPEN_FAILED: 'PearDrop could not show the received file in its folder.'
  }
  const error = new Error(messages[code] || messages.INVALID_STATE)
  error.code = code
  error.retryable = false
  if (detail) error.cause = new Error(detail)
  return error
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

module.exports = DropController
module.exports.CHANNELS = CHANNELS
module.exports.controllerError = controllerError
