const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MAX_FRAME_BYTES,
  createRequestTracker,
  parseFrame,
  serializeFrame
} = require('../lib/protocol')

const requestId = '550e8400-e29b-41d4-a716-446655440000'

test('protocol round-trips an exact share.start command', () => {
  const command = {
    v: 1,
    type: 'share.start',
    requestId,
    sourcePath: '/tmp/demo.bin'
  }

  assert.deepEqual(parseFrame(serializeFrame(command)), command)
})

test('protocol rejects malformed, oversized, unknown, or inexact frames', () => {
  const invalidFrames = [
    '{',
    JSON.stringify({ v: 2, type: 'state.get', requestId }),
    JSON.stringify({ v: 1, type: 'state.get', requestId: 'not-a-uuid' }),
    JSON.stringify({ v: 1, type: 'unknown.command', requestId }),
    JSON.stringify({ v: 1, type: 'state.get', requestId, extra: true }),
    JSON.stringify({
      v: 1,
      type: 'share.start',
      requestId,
      sourcePath: 'x'.repeat(MAX_FRAME_BYTES)
    })
  ]

  for (const frame of invalidFrames) {
    assert.throws(
      () => parseFrame(frame),
      (err) => err.code === 'INVALID_FRAME'
    )
  }
})

test('protocol rejects invalid messages before serialization', () => {
  assert.throws(
    () => serializeFrame({ v: 1, type: 'state.get', requestId, extra: true }),
    (err) => err.code === 'INVALID_FRAME'
  )
})

test('request tracker permits lifecycle commands and rejects conflicting retries', () => {
  const tracker = createRequestTracker()
  const inspect = { v: 1, type: 'receive.inspect', requestId, capability: 'ab'.repeat(32) }
  const start = { v: 1, type: 'receive.start', requestId, destinationPath: '/tmp/a' }

  assert.equal(tracker.accept(inspect), 'new')
  assert.equal(tracker.accept({ ...inspect }), 'duplicate')
  assert.equal(tracker.accept(start), 'new')
  assert.equal(tracker.accept({ ...start }), 'duplicate')
  assert.throws(
    () => tracker.accept({ ...start, destinationPath: '/tmp/b' }),
    (err) => err.code === 'INVALID_STATE'
  )
})
