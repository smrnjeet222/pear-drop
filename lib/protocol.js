const b4a = require('b4a')

const PROTOCOL_VERSION = 1
const MAX_FRAME_BYTES = 16 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const COMMAND_SCHEMAS = {
  'state.get': fields(),
  'share.start': fields(['sourcePath']),
  'receive.inspect': fields(['capability']),
  'receive.start': fields(['destinationPath']),
  'transfer.cancel': fields(),
  'transfer.reset': fields(),
  'worker.shutdown': fields()
}

const EVENT_SCHEMAS = {
  'worker.ready': fields(['snapshot'], [], false),
  'command.accepted': fields(['command']),
  'state.changed': fields(['mode', 'state'], ['file', 'capability', 'bytes', 'peers']),
  'receive.metadata': fields(['file']),
  'transfer.progress': fields(['phase', 'transferred', 'total']),
  'transfer.error': fields(['error']),
  'worker.closed': fields([], [], false)
}

const SCHEMAS = { ...COMMAND_SCHEMAS, ...EVENT_SCHEMAS }

function fields(required = [], optional = [], request = true) {
  return {
    required: ['v', 'type', ...(request ? ['requestId'] : []), ...required],
    allowed: new Set(['v', 'type', ...(request ? ['requestId'] : []), ...required, ...optional])
  }
}

function protocolError(message) {
  const err = new Error(message)
  err.code = 'INVALID_FRAME'
  return err
}

function validateMessage(message) {
  if (!isRecord(message)) throw protocolError('Frame must contain a JSON object.')
  if (message.v !== PROTOCOL_VERSION) throw protocolError('Unsupported protocol version.')

  const schema = SCHEMAS[message.type]
  if (!schema) throw protocolError('Unknown message type.')

  for (const key of schema.required) {
    if (!Object.hasOwn(message, key)) throw protocolError(`Missing field: ${key}.`)
  }
  for (const key of Object.keys(message)) {
    if (!schema.allowed.has(key)) throw protocolError(`Unknown field: ${key}.`)
  }

  if (schema.allowed.has('requestId') && !UUID.test(message.requestId)) {
    throw protocolError('requestId must be a UUID.')
  }

  validateFields(message)
  return message
}

function validateFields(message) {
  switch (message.type) {
    case 'share.start':
      requireNonEmptyString(message.sourcePath, 'sourcePath')
      break
    case 'receive.inspect':
      requireNonEmptyString(message.capability, 'capability')
      break
    case 'receive.start':
      requireNonEmptyString(message.destinationPath, 'destinationPath')
      break
    case 'worker.ready':
      requireRecord(message.snapshot, 'snapshot')
      break
    case 'command.accepted':
      if (!Object.hasOwn(COMMAND_SCHEMAS, message.command)) {
        throw protocolError('command must name a known command.')
      }
      break
    case 'state.changed':
      if (!['send', 'receive', null].includes(message.mode)) {
        throw protocolError('mode is invalid.')
      }
      requireNonEmptyString(message.state, 'state')
      if (Object.hasOwn(message, 'file')) validateFile(message.file)
      if (Object.hasOwn(message, 'capability')) {
        requireNonEmptyString(message.capability, 'capability')
      }
      if (Object.hasOwn(message, 'bytes')) requireRecord(message.bytes, 'bytes')
      if (Object.hasOwn(message, 'peers')) requireInteger(message.peers, 'peers')
      break
    case 'receive.metadata':
      validateFile(message.file)
      break
    case 'transfer.progress':
      requireNonEmptyString(message.phase, 'phase')
      requireInteger(message.transferred, 'transferred')
      requireInteger(message.total, 'total')
      break
    case 'transfer.error':
      validateError(message.error)
      break
  }
}

function validateFile(file) {
  requireExactRecord(file, ['name', 'size'], 'file')
  requireNonEmptyString(file.name, 'file.name')
  requireInteger(file.size, 'file.size')
}

function validateError(error) {
  requireExactRecord(error, ['code', 'message', 'retryable'], 'error')
  requireNonEmptyString(error.code, 'error.code')
  requireNonEmptyString(error.message, 'error.message')
  if (typeof error.retryable !== 'boolean') {
    throw protocolError('error.retryable has an invalid type.')
  }
}

function requireExactRecord(value, keys, name) {
  requireRecord(value, name)
  const actual = Object.keys(value)
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw protocolError(`${name} has unknown or missing fields.`)
  }
}

function requireRecord(value, name) {
  if (!isRecord(value)) throw protocolError(`${name} must be an object.`)
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw protocolError(`${name} must be a non-empty string.`)
  }
}

function requireInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw protocolError(`${name} must be a non-negative integer.`)
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function serializeFrame(message) {
  validateMessage(message)

  let frame
  try {
    frame = b4a.from(JSON.stringify(message))
  } catch {
    throw protocolError('Message is not JSON serializable.')
  }

  if (frame.byteLength > MAX_FRAME_BYTES) throw protocolError('Frame exceeds 16 KiB.')
  return frame
}

function parseFrame(frame) {
  let text
  try {
    text = typeof frame === 'string' ? frame : b4a.toString(frame)
  } catch {
    throw protocolError('Frame must be UTF-8 text.')
  }

  if (b4a.byteLength(text) > MAX_FRAME_BYTES) throw protocolError('Frame exceeds 16 KiB.')

  let message
  try {
    message = JSON.parse(text)
  } catch {
    throw protocolError('Frame must contain valid JSON.')
  }

  return validateMessage(message)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value)

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

function createRequestTracker() {
  const requests = new Map()

  return {
    accept(command) {
      validateMessage(command)
      if (!Object.hasOwn(COMMAND_SCHEMAS, command.type)) {
        throw protocolError('Only commands can be tracked.')
      }

      const fingerprint = canonicalJson(command)
      const key = `${command.requestId}:${command.type}`
      const previous = requests.get(key)
      if (previous === undefined) {
        requests.set(key, fingerprint)
        return 'new'
      }
      if (previous === fingerprint) return 'duplicate'

      const err = new Error('requestId was reused for a conflicting command.')
      err.code = 'INVALID_STATE'
      throw err
    },
    clear() {
      requests.clear()
    }
  }
}

module.exports = {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  createRequestTracker,
  parseFrame,
  serializeFrame,
  validateMessage
}
