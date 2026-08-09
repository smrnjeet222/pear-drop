const b4a = require('b4a')

const CAPABILITY_HEX_LENGTH = 64
const PUBLIC_KEY_BYTES = 32
const HEX_CAPABILITY = /^[0-9a-fA-F]{64}$/

function invalidCapability() {
  const err = new Error("Paste the sender's 64-character PearDrop key.")
  err.code = 'INVALID_CAPABILITY'
  return err
}

function formatCapability(key) {
  if (!key || key.byteLength !== PUBLIC_KEY_BYTES) {
    throw invalidCapability()
  }

  const capability = b4a.toString(key, 'hex').toLowerCase()
  if (capability.length !== CAPABILITY_HEX_LENGTH) throw invalidCapability()

  return capability
}

function parseCapability(value) {
  if (typeof value !== 'string') throw invalidCapability()

  const input = value.trim()
  if (!HEX_CAPABILITY.test(input)) throw invalidCapability()

  const key = b4a.from(input, 'hex')
  if (key.byteLength !== PUBLIC_KEY_BYTES) throw invalidCapability()

  return { capability: formatCapability(key), key }
}

module.exports = {
  CAPABILITY_HEX_LENGTH,
  PUBLIC_KEY_BYTES,
  formatCapability,
  parseCapability
}
