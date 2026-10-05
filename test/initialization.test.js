const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { createRuntime, createTestApi } = require('sounding')
const defineHook = require('../lib')

const runtimeSails = new EventEmitter()
Object.assign(runtimeSails, {
  config: { appPath: process.cwd(), environment: 'test', datastores: {} },
  hooks: {},
  helpers: {},
  models: {},
  log: { info() {}, warn() {}, error() {}, verbose() {} }
})
const test = createTestApi({ runtime: createRuntime(runtimeSails) })

function fixture(t, overrides = {}) {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-no-orm-'))
  fs.mkdirSync(path.join(appPath, 'scripts'))
  fs.writeFileSync(
    path.join(appPath, 'package.json'),
    JSON.stringify({ name: 'quest-no-orm-fixture' })
  )
  fs.writeFileSync(
    path.join(appPath, 'scripts', 'fixture.js'),
    `module.exports={quest:{interval:100000},fn:async()=>true}`
  )
  const app = new (require('sails').Sails)()
  t.after(async () => {
    app.quest?.stop()
    await new Promise((resolve) => app.lower(resolve))
    fs.rmSync(appPath, { recursive: true, force: true })
  })
  return {
    app,
    config: {
      appPath,
      environment: 'test',
      globals: false,
      log: { level: 'silent' },
      hooks: {
        quest: defineHook,
        orm: false,
        grunt: false,
        session: false,
        sockets: false
      },
      quest: { autoStart: false },
      hookTimeout: 2000,
      ...overrides
    }
  }
}

for (const reduced of [false, true]) {
  test(`native Sails load initializes Quest with ORM ${reduced ? 'excluded by loadHooks' : 'explicitly disabled'}`, async ({
    t
  }) => {
    const { app, config } = fixture(
      t,
      reduced
        ? { loadHooks: ['moduleloader', 'userconfig', 'userhooks', 'quest'] }
        : {}
    )
    let loaded = 0
    app.on('hook:quest:loaded', () => {
      loaded++
      assert.ok(app.quest.getRuntime().runtimeId)
    })
    await new Promise((resolve, reject) =>
      app.load(config, (error) => (error ? reject(error) : resolve()))
    )
    assert.equal(loaded, 1)
    assert.equal(app.hooks.orm, undefined)
    assert.equal(app.config.quest.autoStart, false)
    assert.equal(app.quest.metadata('fixture').scheduled, false)
    assert.equal(app.quest.isRunning('fixture'), false)
  })
}

test('database-free initialization preserves source autoStart and cleans up its timer', async ({
  t
}) => {
  const { app, config } = fixture(t, { quest: { autoStart: true } })
  await new Promise((resolve, reject) =>
    app.load(config, (error) => (error ? reject(error) : resolve()))
  )
  assert.equal(app.quest.metadata('fixture').scheduled, true)
  assert.ok(app.quest.metadata('fixture').nextRunAt)
  await app.quest.stop()
  assert.equal(app.quest.metadata('fixture').scheduled, false)
})

test('database-free initialization failure reaches the load callback without a partial API', async ({
  t
}) => {
  const { app, config } = fixture(t, {
    quest: {
      autoStart: false,
      jobs: [{ name: 'duplicate' }, { name: 'duplicate' }]
    }
  })
  let loaded = false
  app.on('hook:quest:loaded', () => {
    loaded = true
  })
  await assert.rejects(
    new Promise((resolve, reject) =>
      app.load(config, (error) => (error ? reject(error) : resolve()))
    ),
    /Duplicate job name/
  )
  assert.equal(loaded, false)
  assert.equal(app.quest, undefined)
})

test('database-free owned execution child suppresses source autoStart in its own process', async ({
  t
}) => {
  const { config } = fixture(t)
  const script = `const {Sails}=require('sails');require('./lib/core/execution-child').markExecutionChild();const app=new Sails();const config=${JSON.stringify({ ...config, hooks: undefined, quest: { autoStart: true }, loadHooks: ['moduleloader', 'userconfig', 'userhooks', 'quest'] })};config.hooks={quest:require('./lib'),orm:false};app.load(config,async error=>{if(error)throw error;const metadata=app.quest.metadata('fixture');const result={autoStart:app.config.quest.autoStart,scheduled:metadata.scheduled,runtimeId:app.quest.getRuntime().runtimeId};await new Promise(resolve=>app.lower(resolve));console.log(JSON.stringify(result))})`
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['-e', script],
    { cwd: path.resolve(__dirname, '..'), timeout: 10000 }
  )
  const result = JSON.parse(stdout.trim())
  assert.equal(result.autoStart, false)
  assert.equal(result.scheduled, false)
  assert.ok(result.runtimeId)
})
