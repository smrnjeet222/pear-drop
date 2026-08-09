const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const preloadPath = path.join(__dirname, '..', 'electron', 'preload.js')
const preloadSource = fs.readFileSync(preloadPath, 'utf8')
const requestId = '550e8400-e29b-41d4-a716-446655440000'

test('preload exposes only eight intent methods and unsubscribes event listeners', async () => {
  const ipcRenderer = new EventEmitter()
  const invocations = []
  let exposed
  ipcRenderer.invoke = (channel, ...args) => {
    invocations.push([channel, ...args])
    return Promise.resolve({ channel, args })
  }

  vm.runInNewContext(preloadSource, {
    require(specifier) {
      assert.equal(specifier, 'electron')
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            exposed = { name, value }
          }
        },
        ipcRenderer
      }
    }
  })

  assert.equal(exposed.name, 'peardrop')
  assert.deepEqual(Object.keys(exposed.value).sort(), [
    'cancel',
    'chooseAndShare',
    'copyCapability',
    'getSnapshot',
    'onEvent',
    'openReceived',
    'receive',
    'reset'
  ])
  assert.equal(Object.isFrozen(exposed.value), true)

  await exposed.value.getSnapshot()
  await exposed.value.chooseAndShare()
  await exposed.value.receive('ab'.repeat(32))
  await exposed.value.cancel(requestId)
  await exposed.value.reset(requestId)
  await exposed.value.copyCapability(requestId)
  await exposed.value.openReceived(requestId)
  assert.deepEqual(invocations, [
    ['peardrop:get-snapshot'],
    ['peardrop:choose-and-share'],
    ['peardrop:receive', 'ab'.repeat(32)],
    ['peardrop:cancel', requestId],
    ['peardrop:reset', requestId],
    ['peardrop:copy-capability', requestId],
    ['peardrop:open-received', requestId]
  ])

  const received = []
  const unsubscribe = exposed.value.onEvent((message) => received.push(message))
  assert.equal(ipcRenderer.listenerCount('peardrop:event'), 1)
  ipcRenderer.emit('peardrop:event', {}, { type: 'state.changed', state: 'idle' })
  assert.deepEqual(received, [{ type: 'state.changed', state: 'idle' }])

  unsubscribe()
  assert.equal(ipcRenderer.listenerCount('peardrop:event'), 0)
  ipcRenderer.emit('peardrop:event', {}, { type: 'worker.closed' })
  assert.equal(received.length, 1)

  assert.throws(
    () => exposed.value.receive({ capability: 'ab'.repeat(32) }),
    /capability must be a string/
  )
  assert.throws(() => exposed.value.cancel('/tmp/arbitrary-path'), /requestId must be a UUID/)
})
