const Hyperdrive = require('hyperdrive')

const { formatCapability, parseCapability } = require('./capability')
const {
  DRIVE_FILE_PATH,
  createManifest,
  createTemporaryPath,
  validateByteCount,
  validateRemoteFile,
  validateSourceFile
} = require('./file-policy')
const { createTransferState, reduceTransferState } = require('./transfer-state')

const DEFAULT_DEADLINES = {
  ingest: 30_000,
  announce: 10_000,
  discovery: 15_000,
  stall: 20_000,
  total: 5 * 60_000,
  destination: 5 * 60_000,
  cleanup: 2_000,
  shutdown: 3_000
}

const ERROR_MESSAGES = {
  ANNOUNCE_TIMEOUT: 'Network announcement failed. Retry sharing.',
  BUSY: 'Finish or cancel the current handoff first.',
  BYTE_MISMATCH: 'Received and expected bytes differ.',
  CANCELLED: 'Handoff stopped.',
  CONNECTION_LOST: 'The sender disconnected. Keep the sender online and retry.',
  DESTINATION_UNWRITABLE: 'Choose another output location.',
  FILE_TOO_LARGE: 'Choose a file no larger than 25 MB.',
  INTERNAL: 'PearDrop stopped safely. Retry after restart.',
  INVALID_CAPABILITY: "Paste the sender's 64-character PearDrop key.",
  INVALID_STATE: 'Finish or cancel the current handoff first.',
  NOT_A_FILE: 'Choose one regular file.',
  REMOTE_MANIFEST_INVALID: 'The key does not identify a supported PearDrop handoff.',
  SENDER_UNAVAILABLE: 'Keep the sender online, verify the key, and retry.',
  SOURCE_CHANGED: 'The source file changed while PearDrop was preparing it.',
  SOURCE_UNREADABLE: 'Choose the source file again.',
  TRANSFER_STALLED: 'The transfer stalled. Keep the sender online and retry.',
  TRANSFER_TIMEOUT: 'The transfer timed out. Keep the sender online and retry.',
  WRITABLE_REPLICA: 'PearDrop refused unexpected write authority.'
}

const RETRYABLE = new Set([
  'ANNOUNCE_TIMEOUT',
  'CONNECTION_LOST',
  'SENDER_UNAVAILABLE',
  'SOURCE_CHANGED',
  'SOURCE_UNREADABLE',
  'TRANSFER_STALLED',
  'TRANSFER_TIMEOUT'
])

class TransferEngine {
  constructor(options = {}) {
    if (!options.store) throw new TypeError('store is required')
    if (!options.filesystem) throw new TypeError('filesystem adapter is required')
    if (!options.path) throw new TypeError('path adapter is required')
    if (typeof options.createSwarm !== 'function') {
      throw new TypeError('createSwarm adapter is required')
    }

    this.store = options.store
    this.filesystem = options.filesystem
    this.path = options.path
    this.createSwarm = options.createSwarm
    this.Hyperdrive = options.Hyperdrive || Hyperdrive
    this.deadlines = { ...DEFAULT_DEADLINES, ...options.deadlines }
    this.logError = options.logError || (() => {})

    this._state = createTransferState()
    this._active = null
    this._listeners = new Set()
    this._closing = false
    this._closed = false
    this._closePromise = null
  }

  onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  snapshot() {
    const snapshot = { ...this._state }
    const context = this._active
    if (!context || this._state.state === 'idle') return snapshot

    if (context.file) snapshot.file = { ...context.file }
    if (context.capability) snapshot.capability = context.capability
    if (context.bytes) snapshot.bytes = { ...context.bytes }
    if (Number.isInteger(context.peers)) snapshot.peers = context.peers
    if (typeof context.writable === 'boolean') snapshot.writable = context.writable

    return snapshot
  }

  async dispatch(command) {
    if (this._closing || this._closed) throw transferError('INVALID_STATE')
    if (!command || typeof command.type !== 'string') throw transferError('INVALID_STATE')

    switch (command.type) {
      case 'state.get':
        return this.snapshot()
      case 'share.start':
        return this._startShare(command)
      case 'receive.inspect':
        return this._inspectReceive(command)
      case 'receive.start':
        return this._startReceive(command)
      case 'transfer.cancel':
        return this._cancel(command.requestId)
      case 'transfer.reset':
        return this._reset(command.requestId)
      default:
        throw transferError('INVALID_STATE')
    }
  }

  async close() {
    if (this._closePromise) return this._closePromise

    this._closing = true
    this._closePromise = this._close()
    return this._closePromise
  }

  async _close() {
    const started = Date.now()
    const context = this._active
    let cleaned = !context
    if (context) {
      context.terminal = true
      context.cancel(transferError('CANCELLED'))
      try {
        await this._cleanupResources(context, {
          removePartial: this._state.state !== 'completed',
          timeout: Math.min(this.deadlines.cleanup, remaining(started, this.deadlines.shutdown)),
          force: true
        })
        cleaned = true
      } catch (err) {
        this.logError(err)
      }
    }

    if (cleaned) {
      this._active = null
      this._state = createTransferState()
    }

    const wait = remaining(started, this.deadlines.shutdown)
    const closed = await settleWithin(
      Promise.resolve().then(() => this.store.close()),
      wait
    )
    if (!closed) this.logError(new Error('Corestore shutdown deadline exceeded'))

    this._closed = true
    this._listeners.clear()
  }

  async _startShare(command) {
    this._assertIdle(command.requestId)

    const context = this._createContext(command.requestId, 'send')
    this._active = context
    this._transition(context, { type: 'share.start', requestId: context.requestId })

    try {
      let sourceStat
      try {
        sourceStat = await this.filesystem.promises.stat(command.sourcePath)
      } catch (err) {
        throw transferError('SOURCE_UNREADABLE', err)
      }

      const source = validateSourceFile(sourceStat)
      const file = createManifest(this.path.basename(command.sourcePath), source.size)
      context.file = { name: file.name, size: file.size }

      await this.store.ready()
      context.transferStore = this.store.namespace(`send-${context.requestId}`)
      context.drive = new this.Hyperdrive(context.transferStore)
      await this._withDeadline(
        context,
        context.drive.ready(),
        this.deadlines.ingest,
        'SOURCE_UNREADABLE'
      )

      if (!context.drive.writable) throw transferError('INTERNAL')

      const sourceStream = this.filesystem.createReadStream(command.sourcePath)
      const driveStream = context.drive.createWriteStream(DRIVE_FILE_PATH, { metadata: file })
      context.streams.add(sourceStream)
      context.streams.add(driveStream)
      context.bytes = { transferred: 0, total: file.size }
      this._emitProgress(context, 'preparing', 0, file.size, true)

      try {
        await this._withDeadline(
          context,
          pipeStreams(sourceStream, driveStream, {
            onChunk: (length) => {
              if (context.terminal) return
              const transferred = context.bytes.transferred + length
              validateByteCount(transferred, file.size)
              context.bytes.transferred = transferred
              this._emitProgress(context, 'preparing', transferred, file.size)
            },
            sourceError: 'SOURCE_UNREADABLE',
            destinationError: 'INTERNAL'
          }),
          this.deadlines.ingest,
          'SOURCE_UNREADABLE'
        )
      } catch (err) {
        await stopStreamPair(sourceStream, driveStream)
        throw err
      } finally {
        context.streams.delete(sourceStream)
        context.streams.delete(driveStream)
      }

      validateByteCount(context.bytes.transferred, file.size, true)
      this._emitProgress(context, 'preparing', file.size, file.size, true)

      let finalStat
      try {
        finalStat = await this.filesystem.promises.stat(command.sourcePath)
      } catch (err) {
        throw transferError('SOURCE_CHANGED', err)
      }
      if (!sameSource(sourceStat, finalStat)) throw transferError('SOURCE_CHANGED')

      const entry = await context.drive.entry(DRIVE_FILE_PATH)
      validateRemoteFile(entry?.value?.metadata, entry)

      this._transition(context, { type: 'share.prepared', requestId: context.requestId })
      await this._openSwarm(context, { server: true, client: false })
      await this._announce(context)

      context.capability = formatCapability(context.drive.key)
      this._transition(context, { type: 'share.announced', requestId: context.requestId })
      return this.snapshot()
    } catch (err) {
      const normalized = normalizeError(err)
      if (!context.terminal) await this._fail(context, normalized)
      throw normalized
    }
  }

  async _inspectReceive(command) {
    this._assertIdle(command.requestId)

    let parsed
    try {
      parsed = parseCapability(command.capability)
    } catch (err) {
      const normalized = normalizeError(err)
      this._emit({
        type: 'transfer.error',
        requestId: command.requestId,
        error: publicError(normalized)
      })
      throw normalized
    }

    const context = this._createContext(command.requestId, 'receive')
    context.capability = parsed.capability
    this._active = context
    this._transition(context, { type: 'receive.inspect', requestId: context.requestId })

    try {
      const discoveryStarted = Date.now()
      await this.store.ready()
      context.transferStore = this.store.session()
      context.drive = new this.Hyperdrive(context.transferStore, parsed.key)
      await this._withDeadline(
        context,
        context.drive.ready(),
        remaining(discoveryStarted, this.deadlines.discovery),
        'SENDER_UNAVAILABLE'
      )

      context.writable = context.drive.writable
      if (context.writable) throw transferError('WRITABLE_REPLICA')

      await this._openSwarm(context, { server: false, client: true })

      let entry
      const doneFinding = context.drive.findingPeers()
      try {
        const update = Promise.resolve(context.drive.update({ wait: true }))
        update.catch(() => {})
        await this._withDeadline(
          context,
          context.swarm.flush(),
          remaining(discoveryStarted, this.deadlines.discovery),
          'SENDER_UNAVAILABLE'
        )
        await this._withDeadline(
          context,
          update,
          remaining(discoveryStarted, this.deadlines.discovery),
          'SENDER_UNAVAILABLE'
        )
        entry = await this._withDeadline(
          context,
          context.drive.entry(DRIVE_FILE_PATH),
          remaining(discoveryStarted, this.deadlines.discovery),
          'SENDER_UNAVAILABLE'
        )
      } finally {
        doneFinding()
      }
      if (!entry) throw transferError('SENDER_UNAVAILABLE')

      context.file = validateRemoteFile(entry.value.metadata, entry)
      context.bytes = { transferred: 0, total: context.file.size }
      this._transition(context, { type: 'receive.discovered', requestId: context.requestId })
      this._emit({
        type: 'receive.metadata',
        requestId: context.requestId,
        file: { ...context.file }
      })
      this._armDestinationDeadline(context)
      return this.snapshot()
    } catch (err) {
      const normalized = normalizeError(err)
      if (!context.terminal) await this._fail(context, normalized)
      throw normalized
    }
  }

  async _startReceive(command) {
    const context = this._assertActive(command.requestId, 'receive', 'awaiting-destination')
    this._clearTimer(context, 'destinationTimer')
    this._transition(context, { type: 'receive.start', requestId: context.requestId })

    try {
      context.temporaryPath = createTemporaryPath(command.destinationPath, context.requestId)
      context.destinationPath = command.destinationPath
      try {
        await removeFile(this.filesystem, context.temporaryPath)
      } catch (err) {
        throw transferError('DESTINATION_UNWRITABLE', err)
      }

      const driveStream = context.drive.createReadStream(DRIVE_FILE_PATH)
      let outputStream
      try {
        outputStream = this.filesystem.createWriteStream(context.temporaryPath, { flags: 'wx' })
      } catch (err) {
        throw transferError('DESTINATION_UNWRITABLE', err)
      }

      context.streams.add(driveStream)
      context.streams.add(outputStream)
      context.bytes = { transferred: 0, total: context.file.size }
      this._emitProgress(context, 'transferring', 0, context.file.size, true)

      const stalled = deferred()
      stalled.promise.catch(() => {})
      const armStall = () => {
        this._clearTimer(context, 'stallTimer')
        context.stallTimer = setTimeout(() => {
          const err = transferError('TRANSFER_STALLED')
          stalled.reject(err)
          destroyStream(driveStream, err)
          destroyStream(outputStream, err)
        }, this.deadlines.stall)
      }
      armStall()

      const total = timeoutPromise(this.deadlines.total, transferError('TRANSFER_TIMEOUT'))
      let acceptingProgress = true
      try {
        await Promise.race([
          pipeStreams(driveStream, outputStream, {
            onChunk: (length) => {
              if (!acceptingProgress || context.terminal) return
              armStall()
              const transferred = context.bytes.transferred + length
              validateByteCount(transferred, context.file.size)
              context.bytes.transferred = transferred
              this._emitProgress(context, 'transferring', transferred, context.file.size)
            },
            sourceError: 'CONNECTION_LOST',
            destinationError: 'DESTINATION_UNWRITABLE'
          }),
          context.cancelPromise,
          stalled.promise,
          total.promise
        ])
      } catch (err) {
        acceptingProgress = false
        await stopStreamPair(driveStream, outputStream)
        throw err
      } finally {
        total.clear()
        this._clearTimer(context, 'stallTimer')
        context.streams.delete(driveStream)
        context.streams.delete(outputStream)
      }

      validateByteCount(context.bytes.transferred, context.file.size, true)
      this._emitProgress(context, 'transferring', context.file.size, context.file.size, true)
      this._transition(context, { type: 'receive.downloaded', requestId: context.requestId })

      let temporaryStat
      try {
        temporaryStat = await this.filesystem.promises.stat(context.temporaryPath)
      } catch (err) {
        throw transferError('DESTINATION_UNWRITABLE', err)
      }
      validateByteCount(temporaryStat.size, context.file.size, true)

      try {
        await this.filesystem.promises.rename(context.temporaryPath, command.destinationPath)
      } catch (err) {
        throw transferError('DESTINATION_UNWRITABLE', err)
      }
      context.temporaryPath = null

      context.terminal = true
      try {
        await this._cleanupResources(context, { removePartial: false })
      } catch (err) {
        context.terminal = false
        throw err
      }
      this._transition(context, { type: 'receive.verified', requestId: context.requestId })
      return this.snapshot()
    } catch (err) {
      const normalized = normalizeError(err)
      if (!context.terminal) await this._fail(context, normalized)
      throw normalized
    }
  }

  async _announce(context) {
    const doneFinding = context.drive.findingPeers()
    try {
      await this._withDeadline(
        context,
        context.swarm.flush(),
        this.deadlines.announce,
        'ANNOUNCE_TIMEOUT'
      )
    } finally {
      doneFinding()
    }
  }

  async _openSwarm(context, joinOptions) {
    context.swarm = await this.createSwarm({
      mode: context.mode,
      requestId: context.requestId,
      discoveryKey: context.drive.discoveryKey
    })
    if (!context.swarm || typeof context.swarm.join !== 'function') {
      throw transferError('INTERNAL')
    }

    context.onConnection = (socket) => {
      if (context.terminal) return destroyStream(socket)
      socket.on?.('error', (err) => this.logError(err))
      try {
        context.transferStore.replicate(socket)
      } catch (err) {
        this.logError(err)
        destroyStream(socket, err)
        return
      }
      context.peers = context.swarm.connections?.size || 0
      this._emitState(context)
    }
    context.onUpdate = () => {
      if (context.terminal) return
      context.peers = context.swarm.connections?.size || 0
      this._emitState(context)
    }
    context.swarm.on('connection', context.onConnection)
    context.swarm.on('update', context.onUpdate)
    context.discovery = context.swarm.join(context.drive.discoveryKey, joinOptions)
  }

  async _cancel(requestId) {
    const context = this._assertActive(requestId)
    if (context.terminal) throw transferError('INVALID_STATE')

    const action = context.mode === 'send' ? 'transfer.cancel' : 'transfer.cancel'
    this._transition(context, { type: action, requestId })
    context.terminal = true
    context.cancel(transferError('CANCELLED'))

    try {
      await this._cleanupResources(context, {
        removePartial: true,
        timeout: this.deadlines.cleanup
      })
    } catch (err) {
      const normalized = normalizeError(err)
      this._transition(context, { type: 'transfer.fail', requestId })
      this._emit({
        type: 'transfer.error',
        requestId,
        error: publicError(normalized)
      })
      throw normalized
    }

    this._transition(context, { type: 'transfer.cancelled', requestId })
    this._active = null
    return this.snapshot()
  }

  async _reset(requestId) {
    const context = this._assertActive(requestId)
    if (!['failed', 'completed'].includes(this._state.state)) {
      throw transferError('INVALID_STATE')
    }

    await this._cleanupResources(context, {
      removePartial: this._state.state !== 'completed',
      timeout: this.deadlines.cleanup
    })
    this._transition(context, { type: 'transfer.reset', requestId })
    this._active = null
    return this.snapshot()
  }

  async _fail(context, error) {
    if (context.terminal) return
    context.terminal = true
    context.cancel(error)

    let cleanupError = null
    try {
      await this._cleanupResources(context, {
        removePartial: true,
        timeout: this.deadlines.cleanup
      })
    } catch (err) {
      cleanupError = normalizeError(err)
    }

    const reportedError = cleanupError || error
    this._transition(context, { type: 'transfer.fail', requestId: context.requestId })
    this._emit({
      type: 'transfer.error',
      requestId: context.requestId,
      error: publicError(reportedError)
    })
    if (cleanupError) throw cleanupError
  }

  async _cleanupResources(context, options = {}) {
    if (context.cleanupPromise) return context.cleanupPromise

    const cleanupPromise = this._cleanup(context, options)
    context.cleanupPromise = cleanupPromise
    try {
      return await cleanupPromise
    } finally {
      if (context.cleanupPromise === cleanupPromise) context.cleanupPromise = null
    }
  }

  async _cleanup(
    context,
    { removePartial = true, timeout = this.deadlines.cleanup, force = false } = {}
  ) {
    const started = Date.now()
    let cleanupFailed = false

    if (context.streams.size > 0) {
      const streams = [...context.streams]
      const streamsClosed = await settleWithin(
        stopStreams(streams),
        remaining(started, timeout)
      )
      if (streamsClosed) {
        for (const stream of streams) context.streams.delete(stream)
      } else {
        cleanupFailed = true
      }
    }

    if (context.swarm) {
      if (context.onConnection) context.swarm.removeListener?.('connection', context.onConnection)
      if (context.onUpdate) context.swarm.removeListener?.('update', context.onUpdate)
    }

    if (context.discovery?.destroy) {
      const discovery = context.discovery
      const destroyed = await settleWithin(
        Promise.resolve().then(() => discovery.destroy()),
        remaining(started, timeout)
      )
      if (destroyed) context.discovery = null
      else cleanupFailed = true
    } else {
      context.discovery = null
    }

    if (context.swarm?.destroy) {
      const swarm = context.swarm
      let destroyed = await settleWithin(
        Promise.resolve().then(() => swarm.destroy(force ? { force: true } : undefined)),
        remaining(started, timeout)
      )
      if (!destroyed && !force) {
        destroyed = await settleWithin(
          Promise.resolve().then(() => swarm.destroy({ force: true })),
          remaining(started, timeout)
        )
      }
      if (destroyed) context.swarm = null
      else cleanupFailed = true
    } else {
      context.swarm = null
    }

    if (removePartial && context.temporaryPath && context.streams.size === 0) {
      const temporaryPath = context.temporaryPath
      const removed = await settleWithin(
        removeFile(this.filesystem, temporaryPath),
        remaining(started, timeout)
      )
      if (removed) context.temporaryPath = null
      else cleanupFailed = true
    }

    if (context.streams.size === 0) {
      const drive = context.drive
      const transferStore = context.transferStore
      const closeTimeout = remaining(started, timeout)
      const [driveClosed, transferStoreClosed] = await Promise.all([
        drive
          ? settleWithin(
              Promise.resolve().then(() => drive.close()),
              closeTimeout
            )
          : true,
        transferStore
          ? settleWithin(
              Promise.resolve().then(() => transferStore.close()),
              closeTimeout
            )
          : true
      ])
      if (driveClosed) context.drive = null
      else cleanupFailed = true
      if (transferStoreClosed) context.transferStore = null
      else cleanupFailed = true
    } else if (context.drive || context.transferStore) {
      cleanupFailed = true
    }

    for (const timer of context.timers) clearTimeout(timer)
    context.timers.clear()
    this._clearTimer(context, 'destinationTimer')
    this._clearTimer(context, 'stallTimer')

    if (cleanupFailed) throw transferError('INTERNAL')
  }

  _armDestinationDeadline(context) {
    this._clearTimer(context, 'destinationTimer')
    context.destinationTimer = setTimeout(() => {
      if (context.terminal || this._active !== context) return
      this._fail(context, transferError('TRANSFER_TIMEOUT')).catch(this.logError)
    }, this.deadlines.destination)
  }

  _clearTimer(context, name) {
    if (!context[name]) return
    clearTimeout(context[name])
    context[name] = null
  }

  async _withDeadline(context, promise, milliseconds, code) {
    const timeout = timeoutPromise(milliseconds, transferError(code))
    try {
      return await Promise.race([promise, context.cancelPromise, timeout.promise])
    } finally {
      timeout.clear()
    }
  }

  _createContext(requestId, mode) {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw transferError('INVALID_STATE')
    }

    const cancelled = deferred()
    cancelled.promise.catch(() => {})
    let didCancel = false

    return {
      requestId,
      mode,
      state: 'active',
      terminal: false,
      cleanupPromise: null,
      transferStore: null,
      drive: null,
      swarm: null,
      discovery: null,
      onConnection: null,
      onUpdate: null,
      streams: new Set(),
      timers: new Set(),
      destinationTimer: null,
      stallTimer: null,
      temporaryPath: null,
      destinationPath: null,
      file: null,
      capability: null,
      bytes: null,
      peers: 0,
      writable: undefined,
      progress: { phase: null, transferred: -1, emittedAt: 0 },
      cancelPromise: cancelled.promise,
      cancel(error) {
        if (didCancel) return
        didCancel = true
        cancelled.reject(error)
      }
    }
  }

  _assertIdle(requestId) {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw transferError('INVALID_STATE')
    }
    if (this._state.state !== 'idle' || this._active) throw transferError('BUSY')
  }

  _assertActive(requestId, mode, state) {
    const context = this._active
    if (!context || context.requestId !== requestId) throw transferError('INVALID_STATE')
    if (mode && context.mode !== mode) throw transferError('INVALID_STATE')
    if (state && this._state.state !== state) throw transferError('INVALID_STATE')
    return context
  }

  _transition(context, action) {
    const previous = this._state
    const next = reduceTransferState(previous, action)
    if (next === previous) throw transferError('INVALID_STATE')
    this._state = next
    this._emitState(context, action.requestId)
  }

  _emitState(context, requestId = context?.requestId) {
    const snapshot = this.snapshot()
    const event = {
      type: 'state.changed',
      requestId,
      mode: snapshot.mode,
      state: snapshot.state
    }
    if (snapshot.file) event.file = snapshot.file
    if (snapshot.capability) event.capability = snapshot.capability
    if (snapshot.bytes) event.bytes = snapshot.bytes
    if (Number.isInteger(snapshot.peers)) event.peers = snapshot.peers
    this._emit(event)
  }

  _emitProgress(context, phase, transferred, total, force = false) {
    if (context.terminal) return
    const now = Date.now()
    const previous = context.progress
    if (!force && previous.phase === phase && previous.transferred === transferred) {
      return
    }
    if (!force && now - previous.emittedAt < 100) return

    context.progress = { phase, transferred, emittedAt: now }
    this._emit({
      type: 'transfer.progress',
      requestId: context.requestId,
      phase,
      transferred,
      total
    })
  }

  _emit(event) {
    for (const listener of [...this._listeners]) {
      try {
        listener(event)
      } catch (err) {
        this.logError(err)
      }
    }
  }
}

function pipeStreams(source, destination, options) {
  return new Promise((resolve, reject) => {
    let settled = false
    let sourceEnded = false
    let destinationFinished = false

    const finish = (err) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err)
      else resolve()
    }
    const onData = (chunk) => {
      try {
        options.onChunk(chunk.byteLength)
      } catch (err) {
        destroyStream(source, err)
        destroyStream(destination, err)
        finish(err)
      }
    }
    const onSourceError = (err) => finish(normalizeStreamError(options.sourceError, err))
    const onDestinationError = (err) => {
      finish(normalizeStreamError(options.destinationError, err))
    }
    const onSourceEnd = () => {
      sourceEnded = true
    }
    const onSourceClose = () => {
      if (!sourceEnded && !settled) finish(transferError(options.sourceError))
    }
    const onDestinationFinish = () => {
      destinationFinished = true
      finish()
    }
    const onDestinationClose = () => {
      if (!destinationFinished && !settled) finish(transferError(options.destinationError))
    }
    const cleanup = () => {
      source.removeListener('data', onData)
      source.removeListener('error', onSourceError)
      source.removeListener('end', onSourceEnd)
      source.removeListener('close', onSourceClose)
      destination.removeListener('error', onDestinationError)
      destination.removeListener('finish', onDestinationFinish)
      destination.removeListener('close', onDestinationClose)
    }

    source.on('data', onData)
    source.once('error', onSourceError)
    source.once('end', onSourceEnd)
    source.once('close', onSourceClose)
    destination.once('error', onDestinationError)
    destination.once('finish', onDestinationFinish)
    destination.once('close', onDestinationClose)

    try {
      source.pipe(destination)
    } catch (err) {
      finish(normalizeStreamError(options.sourceError, err))
    }
  })
}

function sameSource(before, after) {
  if (!after || typeof after.isFile !== 'function' || !after.isFile()) return false
  if (before.size !== after.size) return false
  if (
    Number.isFinite(before.mtimeMs) &&
    Number.isFinite(after.mtimeMs) &&
    before.mtimeMs !== after.mtimeMs
  ) {
    return false
  }
  return true
}

async function removeFile(filesystem, filePath) {
  if (!filePath) return
  try {
    await filesystem.promises.unlink(filePath)
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
}

function destroyStream(stream, error) {
  if (!stream || typeof stream.destroy !== 'function') return
  try {
    stream.destroy(error)
  } catch {}
}

async function stopStreamPair(source, destination) {
  try {
    source?.unpipe?.(destination)
  } catch {}

  await stopStreams([source, destination])
}

async function stopStreams(streams) {
  const openStreams = streams.filter(Boolean)
  for (const stream of openStreams) {
    try {
      stream.unpipe?.()
    } catch {}
  }

  const closed = openStreams.map(waitForStreamClose)
  for (const stream of openStreams) destroyStream(stream)
  await Promise.all(closed)
}

function waitForStreamClose(stream) {
  if (!stream || stream.closed || typeof stream.once !== 'function') return Promise.resolve()

  return new Promise((resolve) => {
    stream.once('close', resolve)
  })
}

function normalizeStreamError(code, cause) {
  if (cause?.code && ERROR_MESSAGES[cause.code]) return cause
  return transferError(code, cause)
}

function normalizeError(error) {
  if (error?.code && ERROR_MESSAGES[error.code]) {
    if (!error.message || error.message === error.code) error.message = ERROR_MESSAGES[error.code]
    error.retryable = RETRYABLE.has(error.code)
    return error
  }
  return transferError('INTERNAL', error)
}

function transferError(code, cause) {
  const error = new Error(ERROR_MESSAGES[code] || ERROR_MESSAGES.INTERNAL)
  error.code = ERROR_MESSAGES[code] ? code : 'INTERNAL'
  error.retryable = RETRYABLE.has(error.code)
  if (cause) error.cause = cause
  return error
}

function publicError(error) {
  const normalized = normalizeError(error)
  return {
    code: normalized.code,
    message: ERROR_MESSAGES[normalized.code] || ERROR_MESSAGES.INTERNAL,
    retryable: normalized.retryable
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function timeoutPromise(milliseconds, error) {
  let timer = null
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(error), Math.max(0, milliseconds))
  })
  promise.catch(() => {})
  return {
    promise,
    clear() {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

async function settleWithin(promise, milliseconds) {
  if (milliseconds <= 0) return false
  const timeout = timeoutPromise(milliseconds, new Error('deadline exceeded'))
  try {
    await Promise.race([promise, timeout.promise])
    return true
  } catch {
    return false
  } finally {
    timeout.clear()
  }
}

function remaining(started, timeout) {
  return Math.max(0, timeout - (Date.now() - started))
}

module.exports = TransferEngine
module.exports.DEFAULT_DEADLINES = DEFAULT_DEADLINES
module.exports.publicError = publicError
module.exports.transferError = transferError
