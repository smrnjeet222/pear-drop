const TRANSITIONS = {
  'send:preparing': {
    'share.prepared': 'announcing',
    'transfer.cancel': 'stopping',
    'transfer.fail': 'failed'
  },
  'send:announcing': {
    'share.announced': 'sharing',
    'transfer.cancel': 'stopping',
    'transfer.fail': 'failed'
  },
  'send:sharing': {
    'transfer.cancel': 'stopping',
    'transfer.fail': 'failed'
  },
  'send:stopping': {
    'transfer.cancelled': 'idle',
    'transfer.fail': 'failed'
  },
  'receive:discovering': {
    'receive.discovered': 'awaiting-destination',
    'transfer.cancel': 'cancelling',
    'transfer.fail': 'failed'
  },
  'receive:awaiting-destination': {
    'receive.start': 'transferring',
    'transfer.cancel': 'cancelling',
    'transfer.fail': 'failed'
  },
  'receive:transferring': {
    'receive.downloaded': 'verifying',
    'transfer.cancel': 'cancelling',
    'transfer.fail': 'failed'
  },
  'receive:verifying': {
    'receive.verified': 'completed',
    'transfer.cancel': 'cancelling',
    'transfer.fail': 'failed'
  },
  'receive:cancelling': {
    'transfer.cancelled': 'idle',
    'transfer.fail': 'failed'
  },
  'send:failed': { 'transfer.reset': 'idle' },
  'receive:failed': { 'transfer.reset': 'idle' },
  'receive:completed': { 'transfer.reset': 'idle' }
}

function createTransferState() {
  return { mode: null, state: 'idle', requestId: null }
}

function reduceTransferState(current, action) {
  if (!current || !action || typeof action.type !== 'string') return current

  if (current.state === 'idle') {
    if (typeof action.requestId !== 'string' || action.requestId.length === 0) return current
    if (action.type === 'share.start') {
      return { mode: 'send', state: 'preparing', requestId: action.requestId }
    }
    if (action.type === 'receive.inspect') {
      return { mode: 'receive', state: 'discovering', requestId: action.requestId }
    }
    return current
  }

  if (action.requestId !== current.requestId) return current

  const nextState = TRANSITIONS[`${current.mode}:${current.state}`]?.[action.type]
  if (!nextState) return current
  if (nextState === 'idle') return createTransferState()

  return { ...current, state: nextState }
}

function isTerminalState(state) {
  return state?.state === 'failed' || state?.state === 'completed'
}

module.exports = { createTransferState, isTerminalState, reduceTransferState }
