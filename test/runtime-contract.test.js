const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Writable } = require('node:stream')
const { EventEmitter } = require('node:events')
const { createRuntime, createTestApi } = require('sounding')
const { executeJob, buildCommandArgs } = require('../lib/core/executor')
const { encodeResult } = require('../lib/core/result')
const resident = require('../lib/core/runtime')
const loader = require('../lib/core/loader')
const control = require('../lib/core/job-control')
const defineHook = require('../lib')

const sails = new EventEmitter()
Object.assign(sails, {
  config: { appPath: process.cwd(), environment: 'test', datastores: {} },
  hooks: {},
  helpers: {},
  models: {},
  log: { info() {}, warn() {}, error() {}, verbose() {} }
})
const test = createTestApi({ runtime: createRuntime(sails) })
const sink = () =>
  new Writable({
    write(_chunk, _encoding, done) {
      done()
    }
  })

function fixture(t, source) {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-contract-'))
  fs.mkdirSync(path.join(appPath, 'scripts'))
  fs.writeFileSync(
    path.join(appPath, 'package.json'),
    JSON.stringify({ name: 'quest-contract-fixture', scripts: {} })
  )
  fs.symlinkSync(
    path.resolve('node_modules'),
    path.join(appPath, 'node_modules'),
    'dir'
  )
  fs.writeFileSync(path.join(appPath, 'scripts', 'fixture.js'), source)
  const job = {
    name: 'fixture',
    withoutOverlapping: true,
    inputSchema: require(path.join(appPath, 'scripts', 'fixture.js')).inputs
  }
  const context = {
    config: { appPath },
    running: new Map(),
    runtime: resident.createRuntime(),
    stdout: sink(),
    stderr: sink()
  }
  t.after(() => fs.rmSync(appPath, { recursive: true, force: true }))
  return {
    appPath,
    job,
    context,
    run: (inputs = {}) => executeJob('fixture', job, inputs, context)
  }
}

const source = `module.exports={ friendlyName:'Contract fixture', habitat:'none', inputs:{ count:{type:'number',defaultsTo:5,min:0}, enabled:{type:'boolean'}, payload:{type:'json'}, label:{type:'string'}, mode:{type:'string',defaultsTo:'object'}, delay:{type:'number',defaultsTo:0} }, fn:async function(inputs){
console.log('{"fake":"result"}'); console.error('successful warning');
if(inputs.delay) await new Promise(r=>setTimeout(r,inputs.delay));
switch(inputs.mode){
case 'undefined': return;
case 'null': return null;
case 'false': return false;
case 'zero': return 0;
case 'cycle': {const x={};x.self=x;return x;}
case 'bigint': return 1n;
case 'large': return 'x'.repeat(100000);
case 'throw': throw new Error('business exploded');
case 'noisy': console.log('x'.repeat(100000));return {ok:true};
default: return inputs;
}} }`

test('real CLI transports typed inputs and business values separately from successful warnings', async ({
  t
}) => {
  const f = fixture(t, source)
  const value = {
    count: 0,
    enabled: false,
    payload: null,
    label: '001',
    mode: 'object',
    delay: 0
  }
  const receipt = await f.run(value)
  assert.equal(receipt.success, true)
  assert.deepEqual(receipt.result, { status: 'available', value })
  assert.match(receipt.logs.stderr, /successful warning/)
  assert.match(receipt.logs.stdout, /fake/)
  assert.equal(f.context.running.size, 0)
  for (const [mode, value] of [
    ['null', null],
    ['false', false],
    ['zero', 0]
  ]) {
    const result = await f.run({ mode })
    assert.deepEqual(result.result, { status: 'available', value })
  }
  assert.equal((await f.run({ mode: 'undefined' })).result.status, 'undefined')
  assert.equal((await f.run()).result.value.count, 5)
})

test('real CLI bounds business results/logs and retains failure diagnostics', async ({
  t
}) => {
  const f = fixture(t, source)
  for (const mode of ['cycle', 'bigint'])
    assert.equal((await f.run({ mode })).result.status, 'serialization_error')
  assert.equal((await f.run({ mode: 'large' })).result.status, 'too_large')
  f.context.config.logBytes = 1024
  const noisy = await f.run({ mode: 'noisy' })
  assert.equal(noisy.logs.stdoutTruncated, true)
  assert.ok(Buffer.byteLength(noisy.logs.stdout) <= 1024)
  assert.deepEqual(noisy.result.value, { ok: true })
  f.context.config.logBytes = 64 * 1024
  await assert.rejects(f.run({ mode: 'throw' }), (error) => {
    assert.match(error.logs.stderr, /business exploded/)
    assert.ok(error.runId)
    return true
  })
  assert.equal(f.context.running.size, 0)
})

test('input admission validation starts no child or business work', async ({
  t
}) => {
  const f = fixture(
    t,
    `module.exports={friendlyName:'Validation fixture',habitat:'none',inputs:{email:{type:'string',required:true,isEmail:true},count:{type:'number',custom:v=>v===0},payload:{type:'json'}},fn:async()=>{require('fs').writeFileSync('business-ran','yes');return true}}`
  )
  const app = new EventEmitter()
  app.log = { error() {} }
  const starts = []
  app.on('quest:job:start', (event) => starts.push(event))
  f.context.sails = app
  const runner = path.join(f.appPath, 'spawn-marker')
  fs.writeFileSync(
    runner,
    "#!/usr/bin/env node\nrequire('fs').writeFileSync('child-spawned','yes');process.exit(0)\n"
  )
  fs.chmodSync(runner, 0o755)
  f.context.config.sailsPath = runner
  for (const inputs of [
    {},
    { email: 'invalid' },
    { email: 'ok@example.com', count: 2 },
    { email: 'ok@example.com', unknown: true },
    { email: 'ok@example.com', payload: 'x'.repeat(100000) }
  ]) {
    const pending = f.run(inputs)
    assert.ok(pending instanceof Promise)
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'E_QUEST_ADMISSION_REJECTED')
      assert.equal(error.admission, 'rejected_before_start')
      assert.equal(error.phase, 'validation')
      assert.equal(error.trigger, 'manual')
      return true
    })
  }
  assert.equal(fs.existsSync(path.join(f.appPath, 'business-ran')), false)
  assert.equal(f.context.running.size, 0)
  assert.equal(starts.length, 0)
  assert.equal(fs.existsSync(path.join(f.appPath, 'child-spawned')), false)
  delete f.context.config.sailsPath
  const receipt = await f.run({
    email: 'ok@example.com',
    count: 0,
    payload: null
  })
  assert.equal(receipt.result.value, true)
  assert.equal(fs.existsSync(path.join(f.appPath, 'business-ran')), true)
})

test('overlapping executions retain resident authority until the last child exits', async ({
  t
}) => {
  const f = fixture(t, source)
  const one = f.run({ delay: 100, mode: 'zero' })
  assert.equal(f.context.running.has('fixture'), true)
  const skipped = await f.run()
  assert.equal(skipped.reason, 'already_running')
  await one
  f.job.withoutOverlapping = false
  const short = f.run({ delay: 50 })
  const long = f.run({ delay: 600 })
  assert.equal(f.context.runtime.active.get('fixture').size, 2)
  await short
  assert.equal(f.context.running.has('fixture'), true)
  assert.equal(f.context.runtime.active.get('fixture').size, 1)
  await long
  assert.equal(f.context.running.has('fixture'), false)
  f.job.paused = true
  assert.equal((await f.run()).reason, 'paused')
})

test('lifecycle identity is visible at admission and remains correlated through failure/success', async ({
  t
}) => {
  const f = fixture(t, source)
  const previous = global.sails
  global.sails = sails
  const events = []
  const listener = (event) => events.push(event)
  for (const name of ['start', 'complete', 'error'])
    sails.on(`quest:job:${name}`, listener)
  t.after(() => {
    global.sails = previous
    for (const name of ['start', 'complete', 'error'])
      sails.off(`quest:job:${name}`, listener)
  })
  const pending = f.run()
  assert.equal(events.length, 1)
  const receipt = await pending
  assert.equal(events[0].runId, receipt.runId)
  assert.equal(events[1].runId, receipt.runId)
  assert.equal(events[0].runtimeId, receipt.runtimeId)
  assert.ok(events[1].sequence > events[0].sequence)
  assert.ok(receipt.finishedAt >= receipt.startedAt)
  await assert.rejects(f.run({ mode: 'throw' }))
  assert.equal(events[2].runId, events[3].runId)
  assert.ok(events[3].sequence > events[2].sequence)
})

test('dedicated transport refuses missing, corrupt, mismatched, or oversized envelopes', async ({
  t
}) => {
  const f = fixture(t, source)
  const runner = path.join(f.appPath, 'fake-sails')
  f.context.config.sailsPath = runner
  for (const [code, status] of [
    ['console.log(\'{\\"result\\":42}\')', 'unsupported'],
    ["require('fs').writeSync(3,'bad-json')", 'unsupported'],
    [
      "require('fs').writeSync(3,JSON.stringify({version:1,runId:'wrong',result:{status:'available',value:42}}))",
      'unsupported'
    ],
    ["require('fs').writeSync(3,'x'.repeat(100000))", 'too_large']
  ]) {
    fs.writeFileSync(runner, '#!/usr/bin/env node\n' + code + '\n')
    fs.chmodSync(runner, 0o755)
    assert.equal((await f.run()).result.status, status)
  }
  f.context.config.sailsPath = path.join(f.appPath, 'missing-runner')
  await assert.rejects(f.run(), (error) => error.code === 'ENOENT')
  assert.equal(f.context.running.size, 0)
  await assert.rejects(
    executeJob('../unsafe', { name: '../unsafe' }, {}, f.context)
  )
  const cyclic = {}
  cyclic.self = cyclic
  await assert.rejects(f.run(cyclic))
  assert.equal(f.context.running.size, 0)
})

test('bounded JSON serialization rejects side effects and preserves primitives', () => {
  for (const value of [null, false, 0, '', [], { x: [1, true] }])
    assert.deepEqual(encodeResult(value).value, value)
  assert.equal(encodeResult(undefined).status, 'undefined')
  for (const value of [1n, Infinity, new Date(), () => 1, { x: undefined }])
    assert.equal(encodeResult(value).status, 'serialization_error')
  let invoked = false
  const value = {
    get x() {
      invoked = true
      return 1
    }
  }
  assert.equal(encodeResult(value).status, 'serialization_error')
  assert.equal(invoked, false)
  assert.equal(encodeResult('é'.repeat(1000), 100).status, 'too_large')
  let deep = {}
  let item = deep
  for (let i = 0; i < 100; i++) item = item.child = {}
  assert.equal(encodeResult(deep).status, 'too_large')
  assert.deepEqual(
    buildCommandArgs('fixture', {
      text: 'a "quoted" $value',
      count: 0,
      enabled: false,
      json: { a: 1 }
    }),
    [
      'run',
      'fixture',
      '--text=a "quoted" $value',
      '--count=0',
      '--enabled=false',
      '--json={"a":1}'
    ]
  )
})

test('loader retains original renamed script and sanitized machine metadata', async ({
  t
}) => {
  const f = fixture(
    t,
    `module.exports={friendlyName:'Renamed fixture',inputs:{count:{type:'number',defaultsTo:0,min:0},secretToken:{type:'string',defaultsTo:'hidden',example:'hidden',custom:()=>true}},quest:{name:'public-job',interval:'1 hour'},fn:async()=>0}`
  )
  const config = {
    appPath: f.appPath,
    jobs: [{ name: 'fixture', inputs: { count: 3 } }]
  }
  const before = JSON.stringify(config.jobs)
  const jobs = await loader.loadJobs(config)
  assert.equal(JSON.stringify(config.jobs), before)
  assert.equal(jobs.get('public-job').script, 'fixture')
  const context = {
    jobs,
    timers: new Map(),
    dueTimes: new Map(),
    runtime: resident.createRuntime(),
    config
  }
  const metadata = resident.metadata(context, 'public-job')
  assert.equal(metadata.inputs.count.defaultsTo, 0)
  assert.equal(metadata.inputs.secretToken.sensitive, true)
  assert.equal('defaultsTo' in metadata.inputs.secretToken, false)
  assert.equal('example' in metadata.inputs.secretToken, false)
  assert.equal(metadata.inputs.secretToken.customValidation, true)
  assert.equal(metadata.scheduled, false)
  assert.equal(metadata.nextRunAt, null)
})

test('registered due time survives long-delay rechecks and clears on stop/consumption', async ({
  t
}) => {
  const originalSet = global.setTimeout,
    originalClear = global.clearTimeout
  const timers = []
  global.setTimeout = (fn, delay) => {
    const timer = { fn, delay }
    timers.push(timer)
    return timer
  }
  global.clearTimeout = () => {}
  t.after(() => {
    global.setTimeout = originalSet
    global.clearTimeout = originalClear
  })
  let now = Date.now(),
    calls = 0
  const realNow = Date.now
  Date.now = () => now
  t.after(() => {
    Date.now = realNow
  })
  const target = new Date(now + 3e9)
  const jobs = new Map([
    [
      'fixture',
      { name: 'fixture', paused: false, withoutOverlapping: true, timeout: 3e9 }
    ]
  ])
  const triggers = []
  const context = {
    jobs,
    timers: new Map(),
    dueTimes: new Map(),
    runtime: resident.createRuntime(),
    getNextRunTime: () => target,
    executeJob: async (_name, _inputs, trigger) => {
      calls++
      triggers.push(trigger)
    }
  }
  control.scheduleJob('fixture', context)
  assert.equal(timers[0].delay, 2147483647)
  assert.equal(context.dueTimes.get('fixture'), target)
  now += 2147483647
  timers[0].fn()
  assert.equal(timers[1].delay, 3e9 - 2147483647)
  assert.equal(calls, 0)
  timers[1].fn()
  assert.equal(calls, 1)
  assert.equal(context.timers.size, 0)
  assert.equal(context.dueTimes.size, 0)
  control.scheduleJob('fixture', context)
  control.stopJobs('fixture', context)
  assert.equal(context.timers.size, 0)
  assert.equal(context.dueTimes.size, 0)
  context.getNextRunTime = () => new Date(now - 1)
  control.scheduleJob('fixture', context)
  assert.equal(calls, 2)
  assert.deepEqual(triggers, ['scheduled', 'scheduled'])
})

test('named exits preserve process compatibility and expose their actual business exit', async ({
  t
}) => {
  const f = fixture(
    t,
    `module.exports={friendlyName:'Exit fixture',habitat:'none',inputs:{fail:{type:'boolean',defaultsTo:false}},exits:{invalid:{description:'No good'}},fn:function(inputs,exits){if(inputs.fail)return exits.invalid('bad');setTimeout(()=>exits.success({count:0}),10)}}`
  )
  assert.deepEqual((await f.run()).result.value, { count: 0 })
  const named = await f.run({ fail: true })
  assert.equal(named.success, true)
  assert.deepEqual(named.result, {
    status: 'available',
    value: 'bad',
    exit: 'invalid'
  })
})

test('actual resident Sails app owns scheduling, manual admission, pause and metadata reads', async ({
  t
}) => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-resident-'))
  fs.mkdirSync(path.join(appPath, 'scripts'))
  fs.writeFileSync(
    path.join(appPath, 'package.json'),
    JSON.stringify({ name: 'quest-resident-fixture', scripts: {} })
  )
  fs.symlinkSync(
    path.resolve('node_modules'),
    path.join(appPath, 'node_modules'),
    'dir'
  )
  fs.writeFileSync(
    path.join(appPath, 'scripts', 'resident.js'),
    `module.exports={friendlyName:'Resident fixture',inputs:{wait:{type:'number',defaultsTo:250}},quest:{interval:100},fn:async function({wait}){await new Promise(r=>setTimeout(r,wait));return {count:0}}}`
  )
  fs.mkdirSync(path.join(appPath, 'config'))
  fs.writeFileSync(
    path.join(appPath, 'config', 'quest.js'),
    'module.exports.quest={autoStart:false}'
  )
  fs.writeFileSync(
    path.join(appPath, 'config', 'hooks.js'),
    "module.exports.hooks={grunt:false,orm:require('sails-hook-orm'),session:false};module.exports.log={level:'silent'}"
  )
  const Sails = require('sails').Sails
  const app = new Sails()
  const previous = global.sails
  const starts = []
  const skippedEvents = []
  app.on('quest:job:skip', (event) => skippedEvents.push(event))
  app.on('quest:job:start', (event) => starts.push(event))
  t.after(async () => {
    await new Promise((resolve) => app.lower(resolve))
    global.sails = previous
    fs.rmSync(appPath, { recursive: true, force: true })
  })
  await new Promise((resolve, reject) =>
    app.load(
      {
        appPath,
        environment: 'console',
        log: { level: 'silent' },
        hooks: {
          quest: defineHook,
          orm: require('sails-hook-orm'),
          grunt: false
        },
        quest: { autoStart: false },
        globals: { sails: true, _: false, async: false, models: false }
      },
      (error) => (error ? reject(error) : resolve())
    )
  )
  assert.ok(app.quest)
  const info = app.quest.getRuntime()
  assert.equal(info.contractVersion, 1)
  assert.equal(info.capabilities.cancellation, false)
  assert.equal(app.quest.metadata('resident').scheduled, false)
  app.quest.pause('resident')
  assert.equal((await app.quest.run('resident'))[0].reason, 'paused')
  app.quest.resume('resident')
  const invalid = app.quest.run('resident', { wait: 'not-a-number' })
  assert.ok(invalid instanceof Promise)
  await assert.rejects(
    invalid,
    (error) =>
      error.code === 'E_QUEST_ADMISSION_REJECTED' &&
      error.validationCode === 'E_INVALID_ARGINS'
  )
  assert.equal(starts.length, 0)
  const pending = app.quest.run('resident', { wait: 400 })
  assert.equal(starts.length, 1)
  assert.equal(starts[0].trigger, 'manual')
  assert.equal(skippedEvents[0].trigger, 'manual')
  assert.equal(app.quest.metadata('resident').runningCount, 1)
  await app.quest.start('resident')
  const meta = app.quest.metadata('resident')
  assert.equal(meta.scheduled, true)
  assert.ok(meta.nextRunAt)
  for (let i = 0; i < 10; i++) app.quest.metadata()
  assert.equal(starts.length, 1)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(starts.length, 1) // scheduled/manual use one no-overlap guard
  app.quest.stop('resident')
  assert.equal(app.quest.metadata('resident').nextRunAt, null)
  const receipt = (await pending)[0]
  assert.equal(receipt.trigger, 'manual')
  assert.ok(
    skippedEvents.some(
      (event) =>
        event.reason === 'already_running' && event.trigger === 'scheduled'
    )
  )
  assert.equal(receipt.result.status, 'available')
  assert.deepEqual(receipt.result.value, { count: 0 })
  assert.equal(app.quest.metadata('resident').runningCount, 0)
  app.quest.pause('resident')
  const paused = app.quest.metadata('resident')
  assert.equal(paused.paused, true)
  assert.equal(info.runtimeId, paused.runtimeId)
  app.quest.resume('resident')
  const scheduledStart = new Promise((resolve) =>
    app.once('quest:job:start', resolve)
  )
  const scheduledComplete = new Promise((resolve) =>
    app.once('quest:job:complete', resolve)
  )
  await app.quest.start('resident')
  assert.equal((await scheduledStart).trigger, 'scheduled')
  app.quest.stop('resident')
  assert.equal((await scheduledComplete).trigger, 'scheduled')
})

test('scheduled input metadata separates effective values from schema and manual overrides', async ({
  t
}) => {
  const f = fixture(
    t,
    `module.exports={friendlyName:'Scheduled inputs',habitat:'none',inputs:{count:{type:'number',defaultsTo:0},enabled:{type:'boolean'},payload:{type:'json'},requiredValue:{type:'string',required:true},secretToken:{type:'string',defaultsTo:'schema-secret'}},quest:{inputs:{count:99,enabled:false,payload:null,secretToken:'configured-secret'}},fn:async inputs=>inputs}`
  )
  const jobs = await loader.loadJobs({ appPath: f.appPath })
  const job = jobs.get('fixture')
  const metadata = resident.metadata(
    {
      jobs,
      timers: new Map(),
      dueTimes: new Map(),
      runtime: resident.createRuntime(),
      config: {}
    },
    'fixture'
  )
  assert.deepEqual(
    { ...metadata.scheduledInputs.values },
    { count: 0, enabled: false, payload: null }
  )
  assert.equal(metadata.scheduledInputs.fields.count.source, 'script_input')
  assert.equal(
    metadata.scheduledInputs.fields.requiredValue.missingRequired,
    true
  )
  assert.equal(metadata.scheduledInputs.fields.secretToken.available, false)
  assert.equal(metadata.scheduledInputs.fields.secretToken.reason, 'sensitive')
  assert.equal(JSON.stringify(metadata).includes('schema-secret'), false)
  assert.equal(JSON.stringify(metadata).includes('configured-secret'), false)
  const receipt = await executeJob(
    'fixture',
    job,
    { requiredValue: 'provided', count: 7 },
    f.context
  )
  assert.equal(receipt.result.value.count, 7)
  assert.equal(receipt.result.value.enabled, false)
  assert.equal(receipt.result.value.payload, null)
  assert.equal(receipt.result.value.secretToken, 'schema-secret')
  assert.equal(job.inputs.count, 99)
  assert.equal(job.scriptInputs.count, 0)
  assert.equal(
    resident.scheduledInputs(job).fields.requiredValue.missingRequired,
    true
  )
})

test('resident restart resets runtime identity/pause, while dropped events have no upstream replay', async ({
  t
}) => {
  const { fork } = require('node:child_process')
  const f = fixture(
    t,
    `module.exports={friendlyName:'Restart fixture',habitat:'none',inputs:{delay:{type:'number',defaultsTo:10}},quest:{interval:10000},fn:async({delay})=>{await new Promise(resolve=>setTimeout(resolve,delay));return {count:0}}}`
  )
  fs.mkdirSync(path.join(f.appPath, 'config'))
  fs.writeFileSync(
    path.join(f.appPath, 'config', 'runtime.js'),
    "module.exports.hooks={grunt:false,session:false};module.exports.log={level:'silent'}"
  )
  const runner = path.join(f.appPath, 'resident-runner.js')
  fs.writeFileSync(
    runner,
    `const app=new(require('sails').Sails)();let deliver=true;const hook=require(${JSON.stringify(path.resolve('lib'))});for(const event of ['start','complete','error']) app.on('quest:job:'+event,data=>{if(deliver)process.send({event,data})});app.load({appPath:__dirname,environment:'console',log:{level:'silent'},globals:false,hooks:{quest:hook,orm:require('sails-hook-orm'),grunt:false,session:false},quest:{autoStart:false}},error=>{if(error)throw error;process.send({ready:true});process.on('message',async({id,command})=>{try{let value;if(command==='runtime')value={runtime:app.quest.getRuntime(),job:app.quest.metadata('fixture'),hasReadRun:typeof app.quest.readRun==='function'};if(command==='pause')value=app.quest.pause('fixture');if(command==='drop')deliver=false;if(command==='run')value=await app.quest.run('fixture',{delay:20});if(command==='lower'){await new Promise(resolve=>app.lower(resolve));process.send({id,value:true});process.exit(0);return}process.send({id,value})}catch(error){process.send({id,error:error.message})}})})`
  )
  const children = []
  t.after(() => {
    for (const child of children) if (child.connected) child.kill()
  })
  async function launch() {
    const child = fork(runner, [], {
      cwd: f.appPath,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    children.push(child)
    const events = []
    const replies = new Map()
    let sequence = 0
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.on('message', (message) => {
        if (message.ready) resolve()
        else if (message.event) events.push(message)
        else if (replies.has(message.id)) {
          const [ok, fail] = replies.get(message.id)
          replies.delete(message.id)
          if (message.error) fail(new Error(message.error))
          else ok(message.value)
        }
      })
      child.once('exit', (code) => {
        if (code) reject(new Error('resident fixture exited ' + code))
      })
    })
    await ready
    const call = (command) =>
      new Promise((resolve, reject) => {
        const id = ++sequence
        replies.set(id, [resolve, reject])
        child.send({ id, command })
      })
    return { child, events, call }
  }
  const one = await launch()
  const initial = await one.call('runtime')
  assert.equal(initial.hasReadRun, false)
  await one.call('pause')
  assert.equal((await one.call('runtime')).job.paused, true)
  await one.call('lower')
  const two = await launch()
  const restarted = await two.call('runtime')
  assert.notEqual(initial.runtime.runtimeId, restarted.runtime.runtimeId)
  assert.equal(restarted.job.paused, false)
  assert.equal(restarted.job.runningCount, 0)
  assert.equal(restarted.job.scheduled, false)
  await two.call('drop')
  const receipt = (await two.call('run'))[0]
  assert.deepEqual(receipt.result, { status: 'available', value: { count: 0 } })
  assert.equal(two.events.length, 0)
  const after = await two.call('runtime')
  assert.equal(after.job.runningCount, 0)
  assert.equal(after.hasReadRun, false)
  assert.equal(two.events.length, 0) // metadata neither replays lost events nor executes jobs
  await two.call('lower')
})

test('failed lifecycle listeners cannot strand resident running state', async ({
  t
}) => {
  const f = fixture(t, source)
  const app = new EventEmitter()
  app.log = { error() {} }
  f.context.sails = app
  app.on('quest:job:start', () => {
    throw new Error('disconnected observer')
  })
  app.on('quest:job:complete', () => {
    throw new Error('terminal observer failed')
  })
  const receipt = await f.run({ mode: 'zero' })
  assert.equal(receipt.result.value, 0)
  assert.equal(f.context.running.size, 0)
  assert.equal(f.context.runtime.active.size, 0)
})

test('config aliases keep original script/schema, source schedule, and per-job overlap authority', async ({
  t
}) => {
  const f = fixture(
    t,
    `module.exports={friendlyName:'Config alias fixture',habitat:'none',inputs:{count:{type:'number',required:true},delay:{type:'number',defaultsTo:100}},fn:async({count,delay})=>{await new Promise(resolve=>setTimeout(resolve,delay));return {count}}}`
  )
  const config = {
    appPath: f.appPath,
    withoutOverlapping: true,
    jobs: [
      {
        name: 'index-from-config',
        script: 'fixture',
        interval: 10000,
        inputs: { count: 3 }
      }
    ]
  }
  const jobs = await loader.loadJobs(config)
  const job = jobs.get('index-from-config')
  assert.equal(job.script, 'fixture')
  assert.equal(job.inputSchema.count.required, true)
  assert.equal(job.interval, 10000)
  assert.equal(job.withoutOverlapping, true)
  const pending = executeJob(job.name, job, {}, f.context)
  assert.equal(
    (await executeJob(job.name, job, {}, f.context)).reason,
    'already_running'
  )
  const receipt = await pending
  assert.deepEqual(receipt.result.value, { count: 3 })
  const context = {
    jobs,
    timers: new Map(),
    dueTimes: new Map(),
    runtime: f.context.runtime,
    config,
    getNextRunTime: () => new Date(Date.now() + 10000),
    executeJob: () => Promise.resolve({ success: true, duration: 0 })
  }
  control.scheduleJob(job.name, context)
  t.after(() => control.stopJobs(job.name, context))
  const meta = resident.metadata(context, job.name)
  assert.equal(meta.script, 'fixture')
  assert.equal(meta.scheduled, true)
  assert.ok(meta.nextRunAt)
  assert.equal(meta.scheduledInputs.values.count, 3)
  assert.equal(meta.scheduledInputs.fields.count.source, 'job_input')
})

test('autoStart source schedules belong only to the resident, never to its CLI job child', async ({
  t
}) => {
  const f = fixture(
    t,
    `module.exports={friendlyName:'Scheduler authority fixture',quest:{interval:10000},fn:async function(){await new Promise(resolve=>setImmediate(resolve));const app=this.sails;const snapshot={autoStart:app.config.quest.autoStart,registered:app.quest.metadata().filter(job=>job.scheduled).map(job=>job.name),otherHook:app.hooks.probe.marker};await new Promise(resolve=>setTimeout(resolve,1300));return snapshot}}`
  )
  fs.writeFileSync(
    path.join(f.appPath, 'scripts', 'sentinel.js'),
    `module.exports={friendlyName:'Bounded scheduler sentinel',habitat:'none',quest:{timeout:800},fn:async()=>{require('fs').appendFileSync('sentinel-fired','sentinel\\n');return true}}`
  )
  fs.mkdirSync(path.join(f.appPath, 'config'))
  const hookPath = process.env.QUEST_REPRO_BASELINE || path.resolve('lib')
  fs.writeFileSync(
    path.join(f.appPath, 'package.json'),
    JSON.stringify({
      name: 'quest-auto-start-fixture',
      scripts: {},
      dependencies: { 'sails-hook-orm': '^4.0.3' }
    })
  )
  fs.mkdirSync(path.join(f.appPath, 'api', 'hooks', 'quest'), {
    recursive: true
  })
  fs.mkdirSync(path.join(f.appPath, 'api', 'hooks', 'probe'), {
    recursive: true
  })
  fs.writeFileSync(
    path.join(f.appPath, 'api', 'hooks', 'quest', 'index.js'),
    `module.exports=require(${JSON.stringify(hookPath)})`
  )
  fs.writeFileSync(
    path.join(f.appPath, 'api', 'hooks', 'probe', 'index.js'),
    "module.exports=function(){return {marker:'other-hook-loaded',initialize:done=>done()}}"
  )
  fs.writeFileSync(
    path.join(f.appPath, 'config', 'runtime.js'),
    `module.exports.quest={autoStart:true};module.exports.globals=false;module.exports.log={level:'silent'};module.exports.hooks={grunt:false,session:false}`
  )
  const app = new (require('sails').Sails)()
  const starts = []
  app.on('quest:job:start', (event) => starts.push(event))
  t.after(async () => {
    await new Promise((resolve) => app.lower(resolve))
  })
  await new Promise((resolve, reject) =>
    app.load(
      {
        appPath: f.appPath,
        environment: 'console',
        globals: false,
        log: { level: 'silent' },
        hooks: {
          quest: defineHook,
          orm: require('sails-hook-orm'),
          grunt: false,
          session: false
        },
        quest: { autoStart: true }
      },
      (error) => (error ? reject(error) : resolve())
    )
  )
  await new Promise((resolve) => setImmediate(resolve)) // Quest's async ORM-after initialization publishes its API on a later microtask.
  assert.equal(app.config.quest.autoStart, true)
  assert.equal(app.quest.metadata('fixture').scheduled, true)
  assert.equal(app.quest.metadata('sentinel').scheduled, true)
  app.quest.stop('sentinel') // Stop the resident's one-shot before it becomes due.
  const due = app.quest.metadata('fixture').nextRunAt
  const receipt = (await app.quest.run('fixture'))[0]
  assert.deepEqual(receipt.result.value, {
    autoStart: false,
    registered: [],
    otherHook: 'other-hook-loaded'
  })
  assert.equal(fs.existsSync(path.join(f.appPath, 'sentinel-fired')), false)
  assert.equal(starts.length, 1)
  assert.equal(app.config.quest.autoStart, true)
  assert.equal(app.quest.metadata('fixture').scheduled, true)
  assert.equal(app.quest.metadata('fixture').nextRunAt, due)
  app.quest.stop()
})

test('terminal numeric exitCode is distinct from native spawn and preflight rejection codes', async ({
  t
}) => {
  const f = fixture(t, source)
  const app = new EventEmitter()
  app.log = { error() {} }
  f.context.sails = app
  const failures = []
  app.on('quest:job:error', (event) => failures.push(event))
  const success = await f.run({ mode: 'zero' })
  assert.equal(success.exitCode, 0)
  await assert.rejects(f.run({ mode: 'throw' }), (error) => {
    assert.equal(error.exitCode, 1)
    assert.equal(error.code, undefined)
    return true
  })
  assert.equal(failures.at(-1).exitCode, 1)
  assert.equal(failures.at(-1).error.code, 1)
  f.context.config.sailsPath = path.join(f.appPath, 'missing-runner')
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.code, 'ENOENT')
    assert.equal(error.exitCode, null)
    return true
  })
  assert.equal(failures.at(-1).exitCode, null)
  assert.equal(failures.at(-1).error.code, null)
  await assert.rejects(f.run({ count: -1 }), (error) => {
    assert.equal(error.code, 'E_QUEST_ADMISSION_REJECTED')
    assert.equal(error.exitCode, undefined)
    return true
  })
  assert.equal(failures.at(-1).phase, 'validation')
  assert.equal(failures.at(-1).exitCode, undefined)
})

test('metadata distinguishes loaded empty schema from unloaded dynamic definitions', async ({
  t
}) => {
  const f = fixture(
    t,
    `module.exports={friendlyName:'Empty schema fixture',habitat:'none',quest:{interval:10000},fn:async()=>true}`
  )
  const jobs = await loader.loadJobs({ appPath: f.appPath })
  loader.addJobDefinition({ name: 'dynamic-unloaded' }, jobs)
  const context = {
    jobs,
    timers: new Map(),
    dueTimes: new Map(),
    runtime: resident.createRuntime(),
    config: {}
  }
  const loaded = resident.metadata(context, 'fixture')
  const dynamic = resident.metadata(context, 'dynamic-unloaded')
  assert.equal(loaded.inputMetadataAvailable, true)
  assert.deepEqual({ ...loaded.inputs }, {})
  assert.equal(dynamic.inputMetadataAvailable, false)
  assert.deepEqual({ ...dynamic.inputs }, {})
  assert.equal(jobs.get('dynamic-unloaded').inputSchema, undefined)
  const app = new EventEmitter()
  app.log = { error() {} }
  const starts = []
  app.on('quest:job:start', (event) => starts.push(event))
  f.context.sails = app
  await assert.rejects(
    executeJob('fixture', jobs.get('fixture'), { unknown: true }, f.context),
    (error) =>
      error.code === 'E_QUEST_ADMISSION_REJECTED' &&
      error.validationCode === 'E_INVALID_ARGINS'
  )
  assert.equal(starts.length, 0)
  const receipt = await executeJob(
    'fixture',
    jobs.get('fixture'),
    {},
    f.context
  )
  assert.equal(receipt.result.value, true)
})

test('resident metadata retains bounded malformed schedule diagnostics and honest registration state', async ({
  t
}) => {
  const f = fixture(
    t,
    `module.exports={friendlyName:'Schedule diagnostics',habitat:'none',fn:async()=>{throw new Error('must not execute')}}`
  )
  const definitions = [
    { name: 'bad-cron', cron: 'not a cron' },
    { name: 'bad-interval', interval: 'not an interval' },
    { name: 'bad-date', date: 'not a date' },
    { name: 'bad-timeout', timeout: 'not a timeout' },
    { name: 'expired', date: '2000-01-01T00:00:00Z' },
    { name: 'unscheduled' },
    { name: 'relative', interval: 100000, date: '2100-01-01' },
    { name: 'one-shot', timeout: 100000 },
    {
      name: 'override',
      cron: '0 9 * * *',
      timezone: 'UTC',
      cronOptions: { tz: 'America/New_York' }
    },
    { name: 'conflict', date: '2100-01-01', timeout: 100000 }
  ].map((job) => ({ ...job, script: 'fixture' }))
  const app = new (require('sails').Sails)()
  const previous = global.sails
  const starts = []
  app.on('quest:job:start', (event) => starts.push(event))
  t.after(async () => {
    app.quest?.stop()
    await new Promise((resolve) => app.lower(resolve))
    global.sails = previous
  })
  await new Promise((resolve, reject) =>
    app.load(
      {
        appPath: f.appPath,
        environment: 'console',
        log: { level: 'silent' },
        hooks: {
          quest: defineHook,
          orm: require('sails-hook-orm'),
          grunt: false
        },
        quest: { autoStart: false, jobs: definitions },
        globals: { sails: true, _: false, async: false, models: false }
      },
      (error) => (error ? reject(error) : resolve())
    )
  )
  const metadata = (name) => app.quest.metadata(name)
  assert.equal(app.quest.getRuntime().capabilities.scheduleDiagnostics, true)
  assert.equal(metadata('bad-cron').scheduleState.validation, 'not_checked')
  assert.equal(metadata('bad-cron').scheduleState.registration, 'not_attempted')
  for (const [name, code] of [
    ['bad-cron', 'CRON'],
    ['bad-interval', 'INTERVAL'],
    ['bad-date', 'DATE'],
    ['bad-timeout', 'TIMEOUT']
  ]) {
    await app.quest.start(name)
    const meta = metadata(name)
    assert.equal(meta.scheduled, false)
    assert.equal(meta.nextRunAt, null)
    assert.equal(meta.scheduleState.registration, 'not_registered')
    assert.equal(meta.scheduleState.validation, 'invalid')
    assert.equal(meta.scheduleState.validationErrors.length, 1)
    assert.equal(
      meta.scheduleState.validationErrors[0].code,
      `E_SCHEDULE_${code}`
    )
    assert.ok(JSON.stringify(meta.scheduleState.validationErrors).length < 256)
    meta.scheduleState.validationErrors[0].code = 'mutated'
    assert.equal(
      metadata(name).scheduleState.validationErrors[0].code,
      `E_SCHEDULE_${code}`
    )
    app.quest.stop(name)
    assert.equal(metadata(name).scheduleState.registration, 'stopped')
    assert.equal(metadata(name).scheduleState.validation, 'invalid')
  }
  await app.quest.start([
    'expired',
    'unscheduled',
    'relative',
    'one-shot',
    'override'
  ])
  assert.equal(metadata('expired').scheduleState.validation, 'valid')
  assert.equal(metadata('expired').scheduleState.reason, 'no_future_run')
  assert.equal(metadata('unscheduled').scheduleState.validation, 'not_checked')
  assert.equal(metadata('unscheduled').scheduleState.reason, 'no_schedule')
  const relative = metadata('relative')
  assert.equal(relative.scheduleState.registration, 'registered')
  assert.equal(relative.scheduleState.validation, 'valid')
  assert.equal(
    relative.scheduleState.restart.timing,
    'relative_to_registration'
  )
  assert.equal(relative.scheduleState.restart.persistence, 'memory_only')
  assert.equal(relative.scheduleState.restart.missedRuns, 'not_replayed')
  assert.equal(metadata('one-shot').scheduleState.restart.oneShot, true)
  assert.equal(metadata('override').schedule.timezone, 'America/New_York')
  assert.equal(metadata('override').scheduleState.restart.timing, 'wall_clock')
  await assert.rejects(app.quest.start('conflict'), /Cannot combine/)
  assert.equal(metadata('conflict').scheduleState.registration, 'failed')
  assert.equal(
    metadata('conflict').scheduleState.validationErrors[0].code,
    'E_SCHEDULE_CONFLICT'
  )
  for (let i = 0; i < 10; i++) app.quest.metadata()
  assert.equal(starts.length, 0)
  app.quest.stop('relative')
  assert.equal(metadata('relative').scheduleState.validation, 'valid')
  assert.equal(metadata('relative').scheduleState.registration, 'stopped')
  assert.equal(metadata('relative').nextRunAt, null)
})

test('unsafe schedule values register no timers or executions, and cron override follows DST', async () => {
  const scheduler = require('../lib/core/scheduler')
  const context = {
    jobs: new Map(),
    timers: new Map(),
    dueTimes: new Map(),
    scheduleStates: new Map(),
    executeJob: async () => {
      throw new Error('unsafe admission')
    }
  }
  let executions = 0
  context.executeJob = async () => {
    executions++
    return { success: true, duration: 0 }
  }
  context.getNextRunTime = (job) =>
    scheduler.getNextRunTime(job, {}, (assessment) =>
      context.scheduleStates.set(job.name, {
        ...context.scheduleStates.get(job.name),
        ...assessment
      })
    )
  for (const value of [
    -1,
    0,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_VALUE,
    '-1 second',
    {},
    0.1
  ]) {
    context.jobs.set('unsafe', { name: 'unsafe', interval: value })
    control.scheduleJob('unsafe', context)
    assert.equal(context.timers.size, 0)
    assert.equal(context.dueTimes.size, 0)
    assert.equal(context.scheduleStates.get('unsafe').validation, 'invalid')
  }
  for (const definition of [
    { timeout: NaN },
    { timeout: Infinity },
    { timeout: -1 },
    { date: new Date(NaN) },
    { date: {} },
    { date: NaN }
  ]) {
    context.jobs.set('unsafe', { name: 'unsafe', ...definition })
    control.scheduleJob('unsafe', context)
    assert.equal(context.scheduleStates.get('unsafe').validation, 'invalid')
    assert.equal(context.timers.size, 0)
  }
  context.jobs.set('unsafe', { name: 'unsafe', timeout: 0 })
  control.scheduleJob('unsafe', context)
  assert.equal(executions, 1)
  assert.equal(context.scheduleStates.get('unsafe').registration, 'consumed')
  assert.equal(context.scheduleStates.get('unsafe').validation, 'valid')
  assert.equal(context.timers.size, 0)
  const job = {
    name: 'dst',
    cron: '0 9 * * *',
    timezone: 'UTC',
    cronOptions: { tz: 'America/New_York', currentDate: '2026-03-07T15:00:00Z' }
  }
  assert.equal(
    scheduler.getNextRunTime(job).toISOString(),
    '2026-03-08T13:00:00.000Z'
  )
  job.cronOptions.currentDate = '2026-03-06T15:00:00Z'
  assert.equal(
    scheduler.getNextRunTime(job).toISOString(),
    '2026-03-07T14:00:00.000Z'
  )
  job.cronOptions.tz = 'UTC'
  assert.equal(
    scheduler.getNextRunTime(job).toISOString(),
    '2026-03-07T09:00:00.000Z'
  )
  let assessment
  scheduler.getNextRunTime(
    {
      ...job,
      cronOptions: { currentDate: '2026-03-07', endDate: '2026-03-07' }
    },
    {},
    (value) => {
      assessment = value
    }
  )
  assert.equal(assessment.validation, 'valid')
  assert.equal(assessment.reason, 'no_future_run')
})
