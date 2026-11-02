const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Writable } = require('node:stream')
const { executeJob } = require('../lib/core/executor')
const { createRuntime } = require('../lib/core/runtime')
const tick = () => new Promise((resolve) => setImmediate(resolve))
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-admission-'))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.symlinkSync(
    path.resolve('node_modules'),
    path.join(root, 'node_modules'),
    'dir'
  )
  fs.writeFileSync(
    path.join(root, 'scripts', 'poll.js'),
    'module.exports={fn:async()=>true}'
  )
  const runner = path.join(root, 'runner')
  fs.writeFileSync(
    runner,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'ran'))},'run\\n')`
  )
  fs.chmodSync(runner, 0o755)
  const app = new EventEmitter()
  app.log = { error() {} }
  const events = []
  for (const event of ['start', 'complete', 'error', 'skip'])
    app.on('quest:job:' + event, (value) => events.push({ event, ...value }))
  const sink = new Writable({
    write(_v, _e, done) {
      done()
    }
  })
  const context = {
    sails: app,
    trigger: 'scheduled',
    config: { appPath: root, sailsPath: runner, admissionTimeoutMs: 20 },
    runtime: createRuntime(),
    running: new Map(),
    stdout: sink,
    stderr: sink
  }
  const job = {
    name: 'poll',
    execution: 'isolated',
    withoutOverlapping: true,
    inputSchema: { count: { type: 'number', defaultsTo: 0 } }
  }
  const run = (inputs = {}, trigger = 'scheduled') =>
    executeJob('poll', job, inputs, { ...context, trigger })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    root,
    app,
    events,
    context,
    job,
    run,
    ran: () => fs.existsSync(path.join(root, 'ran'))
  }
}

test('empty scheduled poll normalizes defaults, preserves identity and starts no process', async (t) => {
  const f = fixture(t)
  f.job.when = async ({ sails, inputs, name }) => {
    assert.equal(sails, f.app)
    assert.equal(inputs.count, 0)
    assert.equal(name, 'poll')
    return false
  }
  const r = await f.run()
  assert.equal(r.reason, 'no_work')
  assert.equal(r.trigger, 'scheduled')
  assert.ok(r.runId && r.finishedAt)
  assert.equal(f.ran(), false)
  assert.deepEqual(
    f.events.map((e) => e.event),
    ['skip']
  )
  assert.equal(f.context.running.size, 0)
})
test('manual invocation bypasses only the scheduled hint; ordinary input validation remains', async (t) => {
  const f = fixture(t)
  let calls = 0
  f.job.when = () => {
    calls++
    throw Error('must not run')
  }
  await assert.rejects(f.run({ count: 'not-a-number' }, 'manual'), {
    code: 'E_QUEST_ADMISSION_REJECTED'
  })
  const r = await f.run({ count: 1 }, 'manual')
  assert.equal(r.success, true)
  assert.equal(calls, 0)
  assert.equal(f.ran(), true)
})
test('query errors and non-boolean answers are visible admission errors, never empty successes', async (t) => {
  const f = fixture(t)
  f.job.when = async () => {
    throw Error('synthetic database unavailable')
  }
  await assert.rejects(
    f.run(),
    (e) =>
      e.phase === 'scheduled_admission' &&
      e.code === 'E_QUEST_ADMISSION_CHECK_FAILED'
  )
  f.job.when = () => undefined
  await assert.rejects(f.run(), /must return a boolean/)
  assert.equal(f.events.filter((e) => e.event === 'skip').length, 0)
  assert.equal(f.ran(), false)
  f.job.when = () => false
  assert.equal((await f.run()).reason, 'no_work')
})
test('predicate deadline retains the pending query lock and a late true cannot dispatch', async (t) => {
  const f = fixture(t)
  let resolve
  let calls = 0
  f.job.when = () => {
    calls++
    return new Promise((r) => {
      resolve = r
    })
  }
  await assert.rejects(
    f.run(),
    (e) => e.code === 'E_QUEST_ADMISSION_TIMEOUT' && e.queryUnconfirmed
  )
  assert.equal((await f.run()).reason, 'admission_pending')
  assert.equal(calls, 1)
  resolve(true)
  await tick()
  assert.equal(f.ran(), false)
  assert.equal(f.context.admissions, undefined) // runtime owns the lock
  assert.equal(f.context.runtime.admissions.size, 0)
  f.job.when = () => false
  assert.equal((await f.run()).reason, 'no_work')
})
test('pause and drain are rechecked after asynchronous read-only admission', async (t) => {
  const f = fixture(t)
  let resolve
  f.job.when = () =>
    new Promise((r) => {
      resolve = r
    })
  const pending = f.run()
  await tick()
  f.job.paused = true
  resolve(true)
  assert.equal((await pending).reason, 'paused')
  assert.equal(f.ran(), false)
  f.job.paused = false
  const second = f.run()
  await tick()
  f.context.runtime.draining = true
  resolve(true)
  assert.equal((await second).reason, 'draining')
  assert.equal(f.ran(), false)
})
test('overlap admission remains atomic across a delayed predicate and concurrent manual invocation', async (t) => {
  const f = fixture(t)
  let resolve
  f.job.when = () =>
    new Promise((r) => {
      resolve = r
    })
  const pending = f.run()
  await tick()
  const duplicate = await f.run({}, 'manual')
  assert.ok(duplicate.skipped)
  resolve(true)
  assert.equal((await pending).success, true)
  assert.equal(
    fs.readFileSync(path.join(f.root, 'ran'), 'utf8').trim().split('\n').length,
    1
  )
})
