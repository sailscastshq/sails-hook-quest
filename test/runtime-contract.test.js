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
  for (const inputs of [
    {},
    { email: 'invalid' },
    { email: 'ok@example.com', count: 2 },
    { email: 'ok@example.com', unknown: true },
    { email: 'ok@example.com', payload: 'x'.repeat(100000) }
  ])
    await assert.rejects(f.run(inputs))
  assert.equal(fs.existsSync(path.join(f.appPath, 'business-ran')), false)
  assert.equal(f.context.running.size, 0)
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
  const context = {
    jobs,
    timers: new Map(),
    dueTimes: new Map(),
    runtime: resident.createRuntime(),
    getNextRunTime: () => target,
    executeJob: async () => {
      calls++
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
  const pending = app.quest.run('resident', { wait: 400 })
  assert.equal(starts.length, 1)
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
  assert.equal(receipt.result.status, 'available')
  assert.deepEqual(receipt.result.value, { count: 0 })
  assert.equal(app.quest.metadata('resident').runningCount, 0)
  app.quest.pause('resident')
  const paused = app.quest.metadata('resident')
  assert.equal(paused.paused, true)
  assert.equal(info.runtimeId, paused.runtimeId)
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
