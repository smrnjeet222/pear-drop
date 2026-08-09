const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const WorkerBroker = require('../../electron/worker-broker')

test(
  'two real workers create independent stores from separate app storage roots',
  { timeout: 15_000 },
  async (t) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peardrop-worker-roots-'))
    const firstStorage = path.join(dir, 'first', 'app-storage', 'peardrop-corestore')
    const secondStorage = path.join(dir, 'second', 'app-storage', 'peardrop-corestore')
    const entrypoint = require.resolve('../../workers/main.js')
    const first = new WorkerBroker({ entrypoint, storagePath: firstStorage })
    const second = new WorkerBroker({ entrypoint, storagePath: secondStorage })

    t.after(async () => {
      await Promise.allSettled([first.shutdown(), second.shutdown()])
      await fs.promises.rm(dir, { recursive: true, force: true })
    })

    await Promise.all([first.start(), second.start()])
    assert.notEqual(firstStorage, secondStorage)
    assert.equal(await exists(firstStorage), true)
    assert.equal(await exists(secondStorage), true)
    assert.notEqual(
      await fs.promises.realpath(firstStorage),
      await fs.promises.realpath(secondStorage)
    )

    await Promise.all([first.shutdown(), second.shutdown()])
  }
)

async function exists(filePath) {
  try {
    await fs.promises.access(filePath)
    return true
  } catch {
    return false
  }
}
