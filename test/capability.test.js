const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')

const { formatCapability, parseCapability } = require('../lib/capability')

test('parseCapability trims and canonicalizes a 32-byte public key', () => {
  const upper = 'AB'.repeat(32)

  const parsed = parseCapability(`\n ${upper} \t`)

  assert.equal(parsed.capability, 'ab'.repeat(32))
  assert.equal(parsed.key.byteLength, 32)
  assert.equal(b4a.toString(parsed.key, 'hex'), 'ab'.repeat(32))
})

test('parseCapability rejects values that are not exactly 64 hexadecimal characters', () => {
  const invalid = [
    null,
    '',
    'aa'.repeat(31),
    'aa'.repeat(32) + 'a',
    'gg'.repeat(32),
    'a'.repeat(63)
  ]

  for (const value of invalid) {
    assert.throws(
      () => parseCapability(value),
      (err) => err.code === 'INVALID_CAPABILITY'
    )
  }
})

test('formatCapability rejects keys that do not decode to exactly 32 bytes', () => {
  assert.equal(formatCapability(b4a.alloc(32, 0xab)), 'ab'.repeat(32))
  assert.throws(
    () => formatCapability(b4a.alloc(31)),
    (err) => err.code === 'INVALID_CAPABILITY'
  )
})
