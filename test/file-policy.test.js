const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DRIVE_FILE_PATH,
  MANIFEST_SCHEMA,
  MAX_FILE_BYTES,
  createTemporaryPath,
  sanitizeDisplayName,
  validateByteCount,
  validateRemoteFile,
  validateSourceFile
} = require('../lib/file-policy')

test('source policy accepts one regular file up to 25 MB at the fixed drive path', () => {
  const result = validateSourceFile({ isFile: () => true, size: MAX_FILE_BYTES })

  assert.deepEqual(result, { path: DRIVE_FILE_PATH, size: 25 * 1024 * 1024 })
})

test('source policy rejects non-files and files over 25 MB', () => {
  assert.throws(
    () => validateSourceFile({ isFile: () => false, size: 10 }),
    (err) => err.code === 'NOT_A_FILE'
  )
  assert.throws(
    () => validateSourceFile({ isFile: () => true, size: MAX_FILE_BYTES + 1 }),
    (err) => err.code === 'FILE_TOO_LARGE'
  )
})

test('remote policy sanitizes the display name and requires matching bounded sizes', () => {
  const file = validateRemoteFile(
    { schema: MANIFEST_SCHEMA, name: ' folder/\\bad\0name\n.txt ', size: 12 },
    { value: { blob: { byteLength: 12 } } }
  )

  assert.deepEqual(file, { name: 'folder__bad_name_.txt', size: 12 })

  const invalid = [
    [{ schema: 'other/1', name: 'file', size: 12 }, 12],
    [{ schema: MANIFEST_SCHEMA, name: 'file', size: MAX_FILE_BYTES + 1 }, MAX_FILE_BYTES + 1],
    [{ schema: MANIFEST_SCHEMA, name: 'file', size: 12 }, 11]
  ]
  for (const [metadata, byteLength] of invalid) {
    assert.throws(
      () => validateRemoteFile(metadata, { value: { blob: { byteLength } } }),
      (err) => err.code === 'REMOTE_MANIFEST_INVALID'
    )
  }
})

test('file policy creates an adjacent partial path without trusting the file name', () => {
  assert.equal(sanitizeDisplayName('../..\0'), '.._.._')
  assert.equal(sanitizeDisplayName('\0\n'), 'received-file')
  assert.equal(
    createTemporaryPath('/tmp/output.bin', '550e8400-e29b-41d4-a716-446655440000'),
    '/tmp/output.bin.peardrop-550e8400-e29b-41d4-a716-446655440000.part'
  )
})

test('byte policy permits progress but rejects overflow and final underflow', () => {
  assert.equal(validateByteCount(5, 12), 5)
  assert.equal(validateByteCount(12, 12, true), 12)
  assert.throws(
    () => validateByteCount(13, 12),
    (err) => err.code === 'BYTE_MISMATCH'
  )
  assert.throws(
    () => validateByteCount(11, 12, true),
    (err) => err.code === 'BYTE_MISMATCH'
  )
})
