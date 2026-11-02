const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Writable } = require('node:stream')
const { executeJob } = require('../lib/core/executor')
const { createRuntime } = require('../lib/core/runtime')
const { WorkerPool } = require('../lib/core/worker-pool')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const source = `const fs=require('node:fs');
module.exports={friendlyName:'Reusable Sails fixture',inputs:{mode:{type:'string',defaultsTo:'context'},delay:{type:'number',defaultsTo:0},key:{type:'string',defaultsTo:'one'}},exits:{invalid:{}},fn:async function({mode,delay,key}){
 if(mode==='sleep')await new Promise(r=>setTimeout(r,delay));
 if(mode==='spin'){const until=Date.now()+delay;while(Date.now()<until){};return true}
 if(mode==='exit')process.exit(7);
 if(mode==='throw')throw Error('synthetic business failure');
 if(mode==='named')throw {invalid:{reason:'fixture'}};
 if(mode==='forged'){process.send({generation:'stale-worker',runId:'stale-run',type:'complete',result:{status:'available',value:'forged'}});process.send({generation:process.env.QUEST_WORKER_GENERATION,runId:'stale-run',type:'complete',result:{status:'available',value:'forged'}});await new Promise(r=>setTimeout(r,30));return 'genuine'}
 if(mode==='noisy'){console.log('x'.repeat(100000));console.error('y'.repeat(100000));return true}
 if(mode==='claim'){
  try{fs.closeSync(fs.openSync('claim-'+key,'wx'))}catch(e){if(e.code==='EEXIST')return {claimed:false};throw e}
  fs.appendFileSync('started','started\\n');if(delay)await new Promise(r=>setTimeout(r,delay));fs.appendFileSync('completed','done\\n');return {claimed:true,pid:process.pid}
 }
 await sails.models.tally.create({label:key});
 return {pid:process.pid,models:await sails.models.tally.count(),helper:await sails.helpers.ping(),metadataSails:this.sails===sails,autoStart:sails.config.quest.autoStart,scheduled:sails.quest.metadata('fixture').scheduled}
}}
`
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-reuse-'))
  for (const dir of [
    'scripts',
    'config',
    'api/models',
    'api/helpers',
    'api/hooks/quest'
  ])
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  fs.symlinkSync(
    path.resolve('node_modules'),
    path.join(root, 'node_modules'),
    'dir'
  )
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'quest-reuse-fixture',
      scripts: {},
      dependencies: { 'sails-hook-orm': '^4.0.3' }
    })
  )
  fs.writeFileSync(
    path.join(root, 'api/hooks/quest/index.js'),
    `module.exports=require(${JSON.stringify(path.resolve('lib'))})`
  )
  fs.writeFileSync(
    path.join(root, 'api/models/Tally.js'),
    "module.exports={attributes:{label:{type:'string'}},primaryKey:'id'}"
  )
  fs.writeFileSync(
    path.join(root, 'api/helpers/ping.js'),
    'module.exports={fn:async()=>sails.config.custom.fixture}'
  )
  fs.writeFileSync(
    path.join(root, 'config/runtime.js'),
    "module.exports={globals:{sails:true,models:true,_:false,async:false},hooks:{session:false,grunt:false,orm:require('sails-hook-orm')},models:{migrate:'drop',attributes:{id:{type:'number',autoIncrement:true}}},datastores:{default:{adapter:'sails-disk',inMemoryOnly:true}},custom:{fixture:'real-sails-context'},quest:{autoStart:true},log:{level:'silent'}}"
  )
  fs.writeFileSync(
    path.join(root, 'scripts/fixture.js'),
    source.replace(
      "friendlyName:'Reusable Sails fixture',",
      "friendlyName:'Reusable Sails fixture',quest:{interval:10},"
    )
  )
  const app = new EventEmitter()
  app.log = { error() {}, warn() {} }
  const events = []
  for (const name of [
    'start',
    'complete',
    'error',
    'cancelled',
    'timed_out',
    'interrupted',
    'unconfirmed',
    'skip'
  ])
    app.on('quest:job:' + name, (value) =>
      events.push({ event: name, ...value })
    )
  const sink = new Writable({
    write(_c, _e, done) {
      done()
    }
  })
  const context = {
    sails: app,
    runtime: createRuntime(),
    running: new Map(),
    stdout: sink,
    stderr: sink,
    config: {
      appPath: root,
      runtimeControls: true,
      logBytes: 1024,
      worker: {
        concurrency: 1,
        drainTimeoutMs: 1000,
        executionTimeoutMs: 3000,
        ...options
      }
    }
  }
  const job = {
    name: 'fixture',
    withoutOverlapping: true,
    inputSchema: {
      mode: { type: 'string', defaultsTo: 'context' },
      delay: { type: 'number', defaultsTo: 0 },
      key: { type: 'string', defaultsTo: 'one' }
    }
  }
  const run = (inputs = {}, name = 'fixture', overrides = {}) =>
    executeJob(
      name,
      { ...job, ...overrides, name, script: 'fixture' },
      inputs,
      context
    )
  t.after(async () => {
    if (context.runtime.workerPool) await context.runtime.workerPool.drain()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, app, events, context, job, run }
}

test('reuse preserves real Sails models, helpers, config and metadata, without child schedules', async (t) => {
  const f = fixture(t)
  const first = await f.run()
  const second = await f.run({ key: 'two' })
  assert.equal(first.result.value.pid, second.result.value.pid)
  assert.deepEqual(
    { ...first.result.value, pid: 0 },
    {
      pid: 0,
      models: 1,
      helper: 'real-sails-context',
      metadataSails: true,
      autoStart: false,
      scheduled: false
    }
  )
  assert.equal(second.result.value.models, 2)
  assert.notEqual(first.runId, second.runId)
  assert.equal(first.workerGeneration, second.workerGeneration)
  assert.equal(f.context.running.size, 0)
  assert.equal(second.exitCode, null)
})
test('bounded slots reject excess admission without work and forged generation/run results are ignored', async (t) => {
  const f = fixture(t, { maxQueued: 0 })
  await f.run()
  const pending = f.run({ mode: 'sleep', delay: 100 }, 'one')
  const overflow = await f.run({}, 'two')
  assert.equal(overflow.reason, 'worker_busy')
  await pending
  assert.equal((await f.run({ mode: 'forged' })).result.value, 'genuine')
})
test('worker logs/results remain bounded and named exits retain business output', async (t) => {
  const f = fixture(t)
  const noisy = await f.run({ mode: 'noisy' })
  assert.ok(noisy.logs.stdoutTruncated && noisy.logs.stderrTruncated)
  assert.ok(Buffer.byteLength(noisy.logs.stdout) <= 1024)
  const named = await f.run({ mode: 'named' })
  assert.equal(named.result.exit, 'invalid')
  assert.deepEqual(named.result.value, { reason: 'fixture' })
})
test('retirement recycles a worker after its configured run limit without replay', async (t) => {
  const f = fixture(t, { maxRuns: 1 })
  const first = await f.run()
  const second = await f.run()
  assert.notEqual(first.workerGeneration, second.workerGeneration)
  assert.notEqual(first.result.value.pid, second.result.value.pid)
})
test('graceful drain waits for an active run and refuses new leases', async (t) => {
  const f = fixture(t)
  await f.run()
  const pending = f.run({ mode: 'sleep', delay: 80 })
  const drain = f.context.runtime.workerPool.drain()
  assert.equal((await f.run({}, 'other')).reason, 'worker_busy')
  await pending
  await drain
  assert.equal(f.context.runtime.workerPool.slots.size, 0)
})
test('two reusable Sails processes respect an atomic synthetic claim and complete once', async (t) => {
  const f = fixture(t, { concurrency: 2 })
  const both = await Promise.all([
    f.run({ mode: 'claim', key: 'shared', delay: 60 }, 'one'),
    f.run({ mode: 'claim', key: 'shared', delay: 60 }, 'two')
  ])
  assert.equal(both.filter((r) => r.result.value.claimed).length, 1)
  assert.equal(
    fs.readFileSync(path.join(f.root, 'completed'), 'utf8').trim().split('\n')
      .length,
    1
  )
})
test('business exceptions retire the process and report a failure without retry', async (t) => {
  const f = fixture(t)
  await assert.rejects(f.run({ mode: 'throw' }), /synthetic business failure/)
  assert.equal(f.events.filter((e) => e.event === 'start').length, 1)
  assert.equal(f.context.runtime.workerPool.slots.size, 0)
  assert.equal((await f.run()).success, true)
})
test(
  'Linux timeout confirms owned process exit before replacement and does not cancel another slot',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = fixture(t, { concurrency: 2 })
    await f.run()
    const timed = f
      .run({ mode: 'spin', delay: 2000 }, 'timed', { executionTimeoutMs: 40 })
      .catch((error) => error)
    const other = f.run({ mode: 'sleep', delay: 150 }, 'other')
    const failure = await timed
    assert.equal(failure.state, 'timed_out')
    assert.equal(failure.outcome, 'unknown')
    assert.equal(failure.confirmed, true)
    assert.equal((await other).success, true)
    assert.equal(f.context.running.size, 0)
  }
)
test(
  'Linux crash after dispatch is interrupted/unknown with no automatic replay',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = fixture(t)
    const failure = await f.run({ mode: 'exit' }).catch((e) => e)
    assert.equal(failure.state, 'interrupted')
    assert.equal(failure.outcome, 'unknown')
    assert.equal(f.events.filter((e) => e.event === 'start').length, 1)
    assert.equal(f.context.runtime.workerPool.slots.size, 0)
  }
)

test('bounded FIFO waiting prevents starvation without extra schedulers or cold starts', async (t) => {
  const f = fixture(t, { maxQueued: 2 })
  const one = f.run({ mode: 'sleep', delay: 40 }, 'one')
  const two = f.run({ key: 'two' }, 'two')
  const three = f.run({ key: 'three' }, 'three')
  assert.equal((await f.run({}, 'overflow')).reason, 'worker_busy')
  const results = await Promise.all([one, two, three])
  assert.deepEqual(
    results.map((x) => x.result.value.models),
    [1, 2, 3]
  )
  assert.equal(new Set(results.map((x) => x.workerGeneration)).size, 1)
  assert.equal(f.context.runtime.workerPool.queue.length, 0)
})
test('queued cancellation is known not dispatched and cannot affect the active child', async (t) => {
  const f = fixture(t)
  await f.run()
  const active = f.run({ mode: 'sleep', delay: 60 }, 'active')
  const queued = f.run({ key: 'queued' }, 'queued').catch((error) => error)
  const id = f.events.find(
    (e) => e.event === 'start' && e.name === 'queued'
  ).runId
  const cancelled = await f.context.runtime.controls.get(id).cancel()
  assert.equal(cancelled.notDispatched, true)
  const failure = await queued
  assert.equal(failure.outcome, 'not_dispatched')
  assert.equal(failure.state, 'cancelled')
  assert.equal((await active).success, true)
  assert.equal((await f.run()).result.value.models, 3)
})
test('a late cancellation handle cannot terminate a later run on the same Sails process', async (t) => {
  const f = fixture(t)
  const first = f.run({ mode: 'sleep', delay: 30 })
  const id = f.events.find((e) => e.event === 'start').runId
  const stale = f.context.runtime.controls.get(id)
  await first
  const second = f.run({ mode: 'sleep', delay: 60 })
  assert.equal((await stale.cancel()).state, 'completed')
  assert.equal((await second).success, true)
})
test('child.killed and native close do not free a slot when tree termination is unconfirmed', async () => {
  const pool = new WorkerPool({ worker: { maxQueued: 0 } })
  let rejection
  const lease = {
    runId: 'synthetic-run',
    dispatched: true,
    settled: false,
    stopReason: null,
    logBytes: 1024,
    reject: (error) => {
      rejection = error
    }
  }
  const slot = {
    generation: 'synthetic-generation',
    child: { killed: true, send() {} },
    ownership: {
      cancel: async () => ({ state: 'unconfirmed', confirmed: false })
    },
    busy: lease,
    resolveExit() {},
    resolveRetired() {},
    closed: false
  }
  pool.slots.set(slot.generation, slot)
  assert.equal((await pool.stop(slot, lease, 'timed_out')).confirmed, false)
  await pool.closedSlot(slot, null, 'SIGKILL')
  assert.equal(rejection.state, 'unconfirmed')
  assert.equal(rejection.outcome, 'unknown')
  assert.equal(pool.slots.size, 1)
  assert.equal(slot.quarantined, true)
  assert.equal((await pool.stop(slot, lease, 'cancelled')).confirmed, false)
  assert.equal(pool.acquire('new-run'), null)
})

test('reuse introduces no execution deadline unless the application configures one', async (t) => {
  const f = fixture(t, { executionTimeoutMs: undefined })
  await f.run()
  const run = f.run({ mode: 'sleep', delay: 40 })
  const slot = [...f.context.runtime.workerPool.slots.values()].find(
    (x) => x.busy
  )
  assert.equal(slot.busy.executionTimer, null)
  await run
})
test('Sails beforeShutdown preserves the user callback and drains jobs before ORM teardown', async (t) => {
  const f = fixture(t)
  const previous = global.sails
  const app = new (require('sails').Sails)()
  const order = []
  try {
    await new Promise((resolve, reject) =>
      app.load(
        {
          appPath: f.root,
          environment: 'console',
          quest: { autoStart: false },
          beforeShutdown(done) {
            order.push('user')
            done()
          }
        },
        (error) => (error ? reject(error) : resolve())
      )
    )
    app.on('quest:job:complete', () => order.push('complete'))
    app.on('lower', () => order.push('lower'))
    const pending = app.quest.run('fixture', { mode: 'sleep', delay: 50 })
    await Promise.all([
      pending,
      new Promise((resolve, reject) =>
        app.lower((error) => (error ? reject(error) : resolve()))
      )
    ])
    assert.ok(order.indexOf('user') >= 0)
    assert.ok(order.indexOf('complete') < order.indexOf('lower'))
    assert.equal(order.filter((x) => x === 'user').length, 1)
    assert.equal((await app.quest.run('fixture'))[0].reason, 'draining')
  } finally {
    await new Promise((resolve) => app.lower(resolve))
    global.sails = previous
  }
})

test('natural business completion racing cancellation is preserved after confirmed retirement', async () => {
  const pool = new WorkerPool({ worker: { maxQueued: 0 } })
  let prove, close, received, rejection
  const proof = new Promise((resolve) => {
    prove = resolve
  })
  const exited = new Promise((resolve) => {
    close = resolve
  })
  const lease = {
    runId: 'race-run',
    dispatched: true,
    settled: false,
    stopReason: null,
    resultBytes: 1024,
    logBytes: 1024,
    resolve: (value) => {
      received = value
    },
    reject: (error) => {
      rejection = error
    }
  }
  const slot = {
    generation: 'race-generation',
    child: { send() {} },
    ownership: { cancel: () => proof },
    busy: lease,
    exited,
    resolveExit: close,
    resolveRetired() {},
    closed: false
  }
  pool.slots.set(slot.generation, slot)
  const stopped = pool.stop(slot, lease, 'cancelled')
  await pool.message(slot, {
    type: 'complete',
    generation: slot.generation,
    runId: lease.runId,
    result: { status: 'available', value: false },
    logs: { stdout: 'done' }
  })
  assert.equal(received, undefined)
  assert.equal(lease.settled, false)
  await pool.closedSlot(slot, 0, null)
  prove({ state: 'exited', confirmed: true })
  assert.equal((await stopped).state, 'completed')
  assert.equal(rejection, undefined)
  assert.deepEqual(received.result, { status: 'available', value: false })
  assert.equal(pool.slots.size, 0)
})

test('idle recycling releases the warm Sails memory floor and next work gets a new context', async (t) => {
  const f = fixture(t, { idleTimeoutMs: 40 })
  const first = await f.run()
  const until = Date.now() + 3000
  while (f.context.runtime.workerPool.slots.size && Date.now() < until)
    await delay(10)
  assert.equal(f.context.runtime.workerPool.slots.size, 0)
  const second = await f.run()
  assert.notEqual(second.workerGeneration, first.workerGeneration)
  assert.equal(second.result.value.models, 1)
})
test('waiting request deadlines are known not dispatched and do not interrupt the active run', async (t) => {
  const f = fixture(t, { queueTimeoutMs: 20 })
  await f.run()
  const active = f.run({ mode: 'sleep', delay: 80 }, 'active')
  const waiting = f.run({}, 'waiting').catch((error) => error)
  const failure = await waiting
  assert.equal(failure.outcome, 'not_dispatched')
  assert.equal(failure.code, 'E_QUEST_WORKER_QUEUE_TIMEOUT')
  assert.equal((await active).success, true)
})
test('owned execution identity is process-local and not inherited by unrelated descendants', () => {
  const { spawnSync } = require('node:child_process')
  const modulePath = path.resolve('lib/core/execution-child')
  const code = `const child=require(${JSON.stringify(modulePath)});child.markExecutionChild();const next=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify('console.log(require(' + JSON.stringify(modulePath) + ').isExecutionChild())')}],{encoding:'utf8'});console.log(JSON.stringify({self:child.isExecutionChild(),nested:next.stdout.trim(),enumerable:Object.getOwnPropertyDescriptor(globalThis,Symbol.for('sails.quest.executionChild')).enumerable}))`
  const result = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    timeout: 5000
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    self: true,
    nested: 'false',
    enumerable: false
  })
})

test(
  'Linux cancellation includes owned descendants while another Sails slot remains usable',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = fixture(t, { concurrency: 2 })
    await f.run()
    const script = path.join(f.root, 'scripts', 'fixture.js')
    // A fresh replacement reads this synthetic script; no application data involved.
    await f.context.runtime.workerPool.drain()
    f.context.runtime.workerPool = new WorkerPool(f.context.config)
    fs.writeFileSync(
      script,
      fs
        .readFileSync(script, 'utf8')
        .replace(
          "if(mode==='exit')",
          `if(mode==='descendant'){const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},100000)'],{stdio:'ignore'});fs.writeFileSync('descendant-pid',String(child.pid));await new Promise(resolve=>child.on('close',resolve));return true}if(mode==='exit')`
        )
    )
    const pending = f
      .run({ mode: 'descendant' }, 'tree')
      .catch((error) => error)
    const until = Date.now() + 5000
    while (
      !fs.existsSync(path.join(f.root, 'descendant-pid')) &&
      Date.now() < until
    )
      await delay(10)
    const pid = Number(
      fs.readFileSync(path.join(f.root, 'descendant-pid'), 'utf8')
    )
    const runId = f.events
      .filter((e) => e.event === 'start' && e.name === 'tree')
      .at(-1).runId
    const result = await f.context.runtime.controls.get(runId).cancel()
    assert.equal(result.confirmed, true)
    assert.equal((await pending).state, 'cancelled')
    try {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
      assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    assert.equal((await f.run()).success, true)
  }
)
test(
  'Linux a claim survives a crash without an automatic second side effect',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = fixture(t)
    const script = path.join(f.root, 'scripts', 'fixture.js')
    fs.writeFileSync(
      script,
      source.replace(
        "if(mode==='exit')process.exit(7);",
        "if(mode==='exit'){try{fs.closeSync(fs.openSync('claim-crash','wx'))}catch{};fs.appendFileSync('started','once\\n');process.exit(7)}"
      )
    )
    const failure = await f.run({ mode: 'exit' }).catch((error) => error)
    assert.equal(failure.outcome, 'unknown')
    assert.equal(f.events.filter((e) => e.event === 'start').length, 1)
    assert.equal(
      (await f.run({ mode: 'claim', key: 'crash' })).result.value.claimed,
      false
    )
    assert.equal(
      fs.readFileSync(path.join(f.root, 'started'), 'utf8'),
      'once\n'
    )
    assert.equal(fs.existsSync(path.join(f.root, 'completed')), false)
  }
)

for (const reason of ['business-error', 'idle', 'max-runs']) {
  test(
    'Linux bounds hanging Sails shutdown during ' + reason + ' retirement',
    { skip: process.platform !== 'linux', timeout: 15000 },
    async (t) => {
      const f = fixture(t, {
        retirementTimeoutMs: 100,
        idleTimeoutMs: reason === 'idle' ? 50 : 60000,
        maxRuns: reason === 'max-runs' ? 1 : 100,
        executionTimeoutMs: 10000
      })
      fs.writeFileSync(
        path.join(f.root, 'config/shutdown.js'),
        "module.exports={beforeShutdown:function(done){require('node:fs').writeFileSync('lowering-'+process.pid,'yes')}}"
      )
      let firstPid
      if (reason === 'business-error') {
        const first = await f.run()
        firstPid = first.result.value.pid
        const error = await f.run({ mode: 'throw' }).catch((e) => e)
        assert.equal(error.code, 'E_QUEST_WORKER_BUSINESS_ERROR')
        assert.equal(error.outcome, 'failed')
        assert.equal(error.cancellationConfirmed, true)
        assert.match(error.message, /synthetic business failure/)
      } else {
        firstPid = (await f.run()).result.value.pid
      }
      const deadline = Date.now() + 5000
      while (f.context.runtime.workerPool.slots.size && Date.now() < deadline)
        await delay(10)
      assert.equal(f.context.runtime.workerPool.slots.size, 0)
      assert.equal(f.context.running.size, 0)
      assert.ok(fs.existsSync(path.join(f.root, 'lowering-' + firstPid)))
      assert.throws(() => process.kill(firstPid, 0), { code: 'ESRCH' })
      const next = await f.run({ key: 'after-retirement' })
      assert.notEqual(next.result.value.pid, firstPid)
      assert.equal(next.result.value.models, 1)
      assert.equal(next.success, true)
    }
  )
}
