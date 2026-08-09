const { randomUUID } = require('node:crypto')

const FramedStream = require('framed-stream')
const PearRuntime = require('pear-runtime')

const { parseFrame, serializeFrame } = require('../lib/protocol')

class WorkerBroker {
  constructor(options = {}) {
    if (typeof options.entrypoint !== 'string' || options.entrypoint.length === 0) {
      throw new TypeError('fixed worker entrypoint is required')
    }
    if (typeof options.storagePath !== 'string' || options.storagePath.length === 0) {
      throw new TypeError('worker storage path is required')
    }

    this.runtime = options.runtime || PearRuntime
    this.FramedStream = options.FramedStream || FramedStream
    this.entrypoint = options.entrypoint
    this.storagePath = options.storagePath
    this.readyTimeout = options.readyTimeout || 5_000
    this.acknowledgeTimeout = options.acknowledgeTimeout || 3_000
    this.shutdownTimeout = options.shutdownTimeout || 3_000
    this.log = options.log || console

    this.raw = null
    this.pipe = null
    this._snapshot = { mode: null, state: 'idle', requestId: null }
    this._listeners = new Set()
    this._pending = new Map()
    this._ready = deferred()
    this._workerClosed = deferred()
    this._startPromise = null
    this._shutdownPromise = null
    this._started = false
    this._crashed = false
  }

  onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  snapshot() {
    return clone(this._snapshot)
  }

  start() {
    if (this._startPromise) return this._startPromise
    if (this._shutdownPromise) return Promise.reject(brokerError('WORKER_CRASHED'))

    this._startPromise = this._start()
    return this._startPromise
  }

  async command(type, requestId, fields = {}) {
    await this.start()
    if (this._shutdownPromise || this._crashed) throw brokerError('WORKER_CRASHED')
    return this._sendCommand(type, requestId, fields)
  }

  shutdown() {
    if (this._shutdownPromise) return this._shutdownPromise
    this._shutdownPromise = this._shutdown()
    return this._shutdownPromise
  }

  close() {
    return this.shutdown()
  }

  async _start() {
    try {
      this.raw = this.runtime.run(this.entrypoint, [this.storagePath])
      this.pipe = new this.FramedStream(this.raw)
      this._bind()
      this._started = true

      const timeout = timeoutPromise(this.readyTimeout, brokerError('WORKER_NOT_READY'))
      try {
        await Promise.race([this._ready.promise, timeout.promise])
      } finally {
        timeout.clear()
      }
      return this.snapshot()
    } catch (err) {
      const normalized = normalizeBrokerError(err, 'WORKER_NOT_READY')
      this._crashed = true
      this._rejectAll(normalized)
      this._destroy()
      throw normalized
    }
  }

  _bind() {
    this.pipe.on('data', (frame) => this._onFrame(frame))
    this.pipe.once('error', (err) => this._onCrash(err))
    this.pipe.once('close', () => {
      if (!this._shutdownPromise) this._onCrash(new Error('Worker pipe closed'))
    })

    this.raw.once?.('exit', (code) => {
      if (!this._shutdownPromise) this._onCrash(new Error(`Worker exited with code ${code}`))
    })
    this.raw.stdout?.on('data', (data) => this.log.log?.(data.toString()))
    this.raw.stderr?.on('data', (data) => this.log.error?.(data.toString()))
  }

  _onFrame(frame) {
    let message
    try {
      message = parseFrame(frame)
    } catch (err) {
      this._onCrash(err)
      return
    }

    switch (message.type) {
      case 'worker.ready':
        this._snapshot = clone(message.snapshot)
        this._ready.resolve(this.snapshot())
        break
      case 'command.accepted':
        this._accept(message)
        break
      case 'state.changed':
        this._updateSnapshot(message)
        this._emit(message)
        break
      case 'transfer.error':
        this._rejectPendingError(message)
        this._emit(message)
        break
      case 'worker.closed':
        this._workerClosed.resolve()
        this._emit(message)
        break
      default:
        this._emit(message)
        break
    }
  }

  _accept(message) {
    const pending = this._pending.get(message.requestId)
    if (!pending) return
    if (pending.type !== message.command) {
      this._settlePending(
        message.requestId,
        brokerError('WORKER_UNRESPONSIVE', 'Worker acknowledged the wrong command.')
      )
      return
    }
    this._settlePending(message.requestId, null, message)
  }

  _rejectPendingError(message) {
    if (!this._pending.has(message.requestId)) return
    const err = new Error(message.error.message)
    err.code = message.error.code
    err.retryable = message.error.retryable
    this._settlePending(message.requestId, err)
  }

  _updateSnapshot(message) {
    if (message.state === 'idle') {
      this._snapshot = { mode: null, state: 'idle', requestId: null }
      return
    }

    this._snapshot = {
      mode: message.mode,
      state: message.state,
      requestId: message.requestId
    }
    if (message.file) this._snapshot.file = clone(message.file)
    if (message.capability) this._snapshot.capability = message.capability
    if (message.bytes) this._snapshot.bytes = clone(message.bytes)
    if (Number.isInteger(message.peers)) this._snapshot.peers = message.peers
  }

  _sendCommand(type, requestId, fields = {}) {
    if (!this.pipe || this.pipe.destroyed || this.pipe.destroying) {
      return Promise.reject(brokerError('WORKER_CRASHED'))
    }
    if (this._pending.has(requestId)) {
      return Promise.reject(brokerError('INVALID_STATE'))
    }

    let frame
    try {
      frame = serializeFrame({ v: 1, type, requestId, ...fields })
    } catch (err) {
      return Promise.reject(err)
    }

    const pending = deferred()
    const timer = setTimeout(() => {
      this._settlePending(requestId, brokerError('WORKER_UNRESPONSIVE'))
    }, this.acknowledgeTimeout)
    this._pending.set(requestId, { type, pending, timer })

    try {
      this.pipe.write(frame)
    } catch (err) {
      this._settlePending(requestId, normalizeBrokerError(err, 'WORKER_CRASHED'))
    }

    return pending.promise
  }

  _settlePending(requestId, error, value) {
    const record = this._pending.get(requestId)
    if (!record) return
    this._pending.delete(requestId)
    clearTimeout(record.timer)
    if (error) record.pending.reject(error)
    else record.pending.resolve(value)
  }

  async _shutdown() {
    const started = Date.now()

    if (this.pipe && !this._crashed && this._ready.settled) {
      try {
        await this._sendCommand('worker.shutdown', randomUUID())
      } catch {}

      const timeout = timeoutPromise(
        Math.max(0, this.shutdownTimeout - (Date.now() - started)),
        brokerError('WORKER_UNRESPONSIVE')
      )
      try {
        await Promise.race([this._workerClosed.promise, timeout.promise])
      } catch {
      } finally {
        timeout.clear()
      }
    }

    this._rejectAll(brokerError('WORKER_CRASHED'))
    this._destroy()
    this._listeners.clear()
  }

  _onCrash(cause) {
    if (this._crashed) return
    this._crashed = true
    const error = brokerError('WORKER_CRASHED', undefined, cause)
    this._ready.reject(error)
    this._workerClosed.resolve()
    this._rejectAll(error)

    const requestId = this._snapshot.requestId
    if (requestId) {
      const failed = {
        v: 1,
        type: 'state.changed',
        requestId,
        mode: this._snapshot.mode,
        state: 'failed'
      }
      if (this._snapshot.file) failed.file = clone(this._snapshot.file)
      if (this._snapshot.capability) failed.capability = this._snapshot.capability
      if (this._snapshot.bytes) failed.bytes = clone(this._snapshot.bytes)
      if (Number.isInteger(this._snapshot.peers)) failed.peers = this._snapshot.peers
      this._updateSnapshot(failed)
      this._emit(failed)
      this._emit({
        v: 1,
        type: 'transfer.error',
        requestId,
        error: {
          code: error.code,
          message: error.message,
          retryable: true
        }
      })
    }
  }

  _rejectAll(error) {
    for (const requestId of [...this._pending.keys()]) {
      this._settlePending(requestId, error)
    }
  }

  _destroy() {
    if (this.pipe && !this.pipe.destroyed && !this.pipe.destroying) this.pipe.destroy()
    else if (this.raw && !this.raw.destroyed) this.raw.destroy()
  }

  _emit(event) {
    for (const listener of [...this._listeners]) {
      try {
        listener(clone(event))
      } catch (err) {
        this.log.error?.(err)
      }
    }
  }
}

function deferred() {
  let resolvePromise
  let rejectPromise
  const state = { settled: false }
  state.promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  state.promise.catch(() => {})
  state.resolve = (value) => {
    if (state.settled) return
    state.settled = true
    resolvePromise(value)
  }
  state.reject = (error) => {
    if (state.settled) return
    state.settled = true
    rejectPromise(error)
  }
  return state
}

function timeoutPromise(milliseconds, error) {
  let timer
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(error), Math.max(0, milliseconds))
  })
  promise.catch(() => {})
  return {
    promise,
    clear() {
      clearTimeout(timer)
    }
  }
}

function brokerError(code, message, cause) {
  const messages = {
    INVALID_STATE: 'Finish or cancel the current handoff first.',
    WORKER_CRASHED: 'PearDrop worker stopped. Restart the app.',
    WORKER_NOT_READY: 'PearDrop worker did not become ready.',
    WORKER_UNRESPONSIVE: 'PearDrop worker did not acknowledge the command.'
  }
  const error = new Error(message || messages[code] || messages.WORKER_CRASHED)
  error.code = code
  error.retryable = true
  if (cause) error.cause = cause
  return error
}

function normalizeBrokerError(error, fallback) {
  if (
    error?.code &&
    ['WORKER_CRASHED', 'WORKER_NOT_READY', 'WORKER_UNRESPONSIVE'].includes(error.code)
  ) {
    return error
  }
  return brokerError(fallback, undefined, error)
}

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

module.exports = WorkerBroker
module.exports.brokerError = brokerError
