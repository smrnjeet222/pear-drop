const test = require('node:test')
const assert = require('node:assert/strict')

const { createTransferState, reduceTransferState } = require('../lib/transfer-state')

const requestId = '550e8400-e29b-41d4-a716-446655440000'

test('state reducer starts one sender handoff from idle', () => {
  const initial = createTransferState()
  const preparing = reduceTransferState(initial, { type: 'share.start', requestId })

  assert.deepEqual(initial, { mode: null, state: 'idle', requestId: null })
  assert.deepEqual(preparing, { mode: 'send', state: 'preparing', requestId })
})

test('sender follows prepare, announce, share, and stop transitions', () => {
  const states = reduceAll(
    createTransferState(),
    'share.start',
    'share.prepared',
    'share.announced',
    'transfer.cancel',
    'transfer.cancelled'
  )

  assert.deepEqual(states, ['preparing', 'announcing', 'sharing', 'stopping', 'idle'])
})

test('receiver follows discovery, destination, transfer, verification, and completion', () => {
  const states = reduceAll(
    createTransferState(),
    'receive.inspect',
    'receive.discovered',
    'receive.start',
    'receive.downloaded',
    'receive.verified'
  )

  assert.deepEqual(states, [
    'discovering',
    'awaiting-destination',
    'transferring',
    'verifying',
    'completed'
  ])
})

test('receiver cancellation and terminal reset return to idle', () => {
  let state = reduceTransferState(createTransferState(), {
    type: 'receive.inspect',
    requestId
  })
  state = reduceTransferState(state, { type: 'transfer.cancel', requestId })
  assert.equal(state.state, 'cancelling')
  state = reduceTransferState(state, { type: 'transfer.cancelled', requestId })
  assert.deepEqual(state, createTransferState())

  state = reduceTransferState(createTransferState(), { type: 'share.start', requestId })
  state = reduceTransferState(state, { type: 'transfer.fail', requestId })
  assert.equal(state.state, 'failed')
  state = reduceTransferState(state, { type: 'transfer.reset', requestId })
  assert.deepEqual(state, createTransferState())
})

test('illegal or duplicate terminal actions preserve state identity', () => {
  const idle = createTransferState()
  assert.equal(reduceTransferState(idle, { type: 'receive.verified', requestId }), idle)

  let failed = reduceTransferState(idle, { type: 'share.start', requestId })
  failed = reduceTransferState(failed, { type: 'transfer.fail', requestId })

  assert.equal(reduceTransferState(failed, { type: 'transfer.fail', requestId }), failed)
  assert.equal(
    reduceTransferState(failed, { type: 'transfer.reset', requestId: 'other-request' }),
    failed
  )
})

function reduceAll(initial, ...actions) {
  const states = []
  let current = initial

  for (const type of actions) {
    current = reduceTransferState(current, { type, requestId })
    states.push(current.state)
  }

  return states
}
