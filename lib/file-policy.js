const DRIVE_FILE_PATH = '/file'
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MANIFEST_SCHEMA = 'peardrop/1'
const UNSAFE_NAME_CHARACTERS = /[\/\\\x00-\x1f\x7f-\x9f]/g
const SAFE_REQUEST_ID = /^[a-zA-Z0-9-]+$/

function policyError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function validSize(size) {
  return Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE_BYTES
}

function validateSourceFile(stat) {
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
    throw policyError('NOT_A_FILE', 'Choose one regular file.')
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw policyError('NOT_A_FILE', 'Choose one regular file.')
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw policyError('FILE_TOO_LARGE', 'Choose a file no larger than 25 MB.')
  }

  return { path: DRIVE_FILE_PATH, size: stat.size }
}

function sanitizeDisplayName(name) {
  if (typeof name !== 'string') return 'received-file'
  if (!name.replace(UNSAFE_NAME_CHARACTERS, '').trim()) return 'received-file'

  const sanitized = name.replace(UNSAFE_NAME_CHARACTERS, '_').trim().slice(0, 255)
  if (!sanitized || sanitized === '.' || sanitized === '..') return 'received-file'
  return sanitized
}

function createManifest(name, size) {
  if (!validSize(size)) {
    throw policyError('FILE_TOO_LARGE', 'Choose a file no larger than 25 MB.')
  }

  return { schema: MANIFEST_SCHEMA, name: sanitizeDisplayName(name), size }
}

function validateRemoteFile(metadata, entry) {
  const byteLength = entry?.value?.blob?.byteLength
  const validMetadata =
    metadata !== null &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    Object.keys(metadata).length === 3 &&
    metadata.schema === MANIFEST_SCHEMA &&
    typeof metadata.name === 'string' &&
    Object.hasOwn(metadata, 'size') &&
    validSize(metadata.size)

  if (!validMetadata || !Number.isSafeInteger(byteLength) || byteLength !== metadata.size) {
    throw policyError(
      'REMOTE_MANIFEST_INVALID',
      'The key does not identify a supported PearDrop handoff.'
    )
  }

  return { name: sanitizeDisplayName(metadata.name), size: metadata.size }
}

function createTemporaryPath(destinationPath, requestId) {
  if (
    typeof destinationPath !== 'string' ||
    destinationPath.length === 0 ||
    destinationPath.includes('\0') ||
    typeof requestId !== 'string' ||
    !SAFE_REQUEST_ID.test(requestId)
  ) {
    throw policyError('DESTINATION_UNWRITABLE', 'Choose another output location.')
  }

  return `${destinationPath}.peardrop-${requestId}.part`
}

function validateByteCount(received, expected, complete = false) {
  const validCounts =
    Number.isSafeInteger(received) &&
    received >= 0 &&
    Number.isSafeInteger(expected) &&
    expected >= 0 &&
    expected <= MAX_FILE_BYTES

  if (!validCounts || received > expected || (complete && received !== expected)) {
    throw policyError('BYTE_MISMATCH', 'Received and expected bytes differ.')
  }

  return received
}

module.exports = {
  DRIVE_FILE_PATH,
  MANIFEST_SCHEMA,
  MAX_FILE_BYTES,
  createManifest,
  createTemporaryPath,
  sanitizeDisplayName,
  validateByteCount,
  validateRemoteFile,
  validateSourceFile
}
