const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Writable } = require('node:stream')
const { executeJob } = require('../lib/core/executor')
const { createRuntime } = require('../lib/core/runtime')

test('default execution retains final logs without emitting opt-in live events', async (t) => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-default-log-'))
  t.after(() => fs.rmSync(appPath, { recursive: true, force: true }))
  fs.mkdirSync(path.join(appPath, 'scripts'))
  fs.writeFileSync(path.join(appPath, 'scripts', 'plain.js'), '')
  const runner = path.join(appPath, 'runner')
  fs.writeFileSync(
    runner,
    '#!/usr/bin/env node\nconsole.log("synthetic default output")'
  )
  fs.chmodSync(runner, 0o755)
  const sails = new EventEmitter(),
    live = []
  sails.log = { warn() {}, error() {} }
  sails.on('quest:job:log', (event) => live.push(event))
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done()
    }
  })
  const result = await executeJob(
    'plain',
    {},
    {},
    {
      sails,
      stdout: sink,
      stderr: sink,
      config: { appPath, sailsPath: runner, runtimeControls: false }
    }
  )
  assert.equal(result.success, true)
  assert.match(result.logs.stdout, /synthetic default output/)
  assert.equal(live.length, 0)
})

async function observedFixture(t, body) {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-outcome-'))
  fs.mkdirSync(path.join(appPath, 'scripts'))
  fs.symlinkSync(
    path.resolve('node_modules'),
    path.join(appPath, 'node_modules')
  )
  fs.writeFileSync(path.join(appPath, 'package.json'), '{"scripts":{}}')
  fs.writeFileSync(
    path.join(appPath, 'scripts', 'observed.js'),
    `module.exports={friendlyName:'Observed synthetic fixture',habitat:'none',inputs:{},fn:async()=>{console.log('synthetic owned root '+process.pid);${body}}}`
  )
  const sails = new EventEmitter(),
    events = [],
    runtime = createRuntime(),
    running = new Map()
  sails.log = { warn() {}, error() {} }
  for (const kind of [
    'start',
    'log',
    'cancelling',
    'unconfirmed',
    'cancelled',
    'complete',
    'skip'
  ])
    sails.on('quest:job:' + kind, (event) => events.push({ kind, ...event }))
  let output = '',
    rootPid,
    rootTicks
  const sink = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString()
      const match = output.match(/synthetic owned root (\d+)/)
      if (match && !rootPid) {
        rootPid = Number(match[1])
        try {
          const stat = fs.readFileSync(`/proc/${rootPid}/stat`, 'utf8')
          rootTicks = stat
            .slice(stat.lastIndexOf(')') + 1)
            .trim()
            .split(/\s+/)[19]
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
      done()
    }
  })
  const job = { inputSchema: {}, withoutOverlapping: true }
  const context = {
    sails,
    runtime,
    running,
    stdout: sink,
    stderr: sink,
    config: { appPath, runtimeControls: true }
  }
  const execution = executeJob('observed', job, {}, context).catch(
    (error) => error
  )
  let control
  const deadline = Date.now() + 5000
  while ((!rootPid || !control) && Date.now() < deadline) {
    control ||= runtime.controls.get(
      events.find((event) => event.kind === 'start')?.runId
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  t.after(async () => {
    if (rootPid && rootTicks) {
      try {
        const stat = fs.readFileSync(`/proc/${rootPid}/stat`, 'utf8')
        const fields = stat
          .slice(stat.lastIndexOf(')') + 1)
          .trim()
          .split(/\s+/)
        if (fields[0] !== 'Z') {
          assert.equal(fields[19], rootTicks)
          assert.ok(
            fs
              .readFileSync(`/proc/${rootPid}/environ`, 'utf8')
              .split('\0')
              .includes(`QUEST_OWNED_RUN_ID=${events[0].runId}`)
          )
          process.kill(rootPid, 'SIGKILL')
        }
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
      }
    }
    await execution
    fs.rmSync(appPath, { recursive: true, force: true })
  })
  assert.ok(control, 'positive owned child control was acquired')
  assert.ok(rootPid, 'real child reached its fixture checkpoint')
  return { rootPid, execution, control, context, job, events, runtime, running }
}

test(
  'unconfirmed cancellation is emitted while the real child remains alive and overlap stays held',
  { skip: process.platform !== 'linux', timeout: 10000 },
  async (t) => {
    const f = await observedFixture(
      t,
      'await new Promise(r=>setTimeout(r,5000));return false'
    )
    const read = fs.readFileSync
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === `/proc/${f.rootPid}/environ`)
        throw Object.assign(new Error('synthetic unreadable member'), {
          code: 'EACCES'
        })
      return read(file, ...args)
    })
    const first = f.control.cancel(),
      duplicate = f.control.cancel()
    assert.equal(first, duplicate)
    assert.equal((await first).state, 'unconfirmed')
    t.mock.restoreAll()
    assert.equal(
      f.events.filter((event) => event.kind === 'unconfirmed').length,
      1
    )
    assert.equal(
      f.events.filter((event) => event.kind === 'cancelled').length,
      0
    )
    assert.equal(process.kill(f.rootPid, 0), true)
    assert.equal(f.runtime.active.get('observed').size, 1)
    assert.equal(f.running.has('observed'), true)
    assert.equal(
      (await executeJob('observed', f.job, {}, f.context)).reason,
      'already_running'
    )
    assert.equal(f.events.filter((event) => event.kind === 'start').length, 1)
  }
)

test(
  'natural child exit before pipe close preserves the business result and duplicate cancellation truth',
  { skip: process.platform !== 'linux', timeout: 10000 },
  async (t) => {
    const f = await observedFixture(
      t,
      `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:['ignore','inherit','inherit']});return false`
    )
    const deadline = Date.now() + 5000
    while (f.runtime.controls.has(f.events[0].runId) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(
      f.runtime.controls.has(f.events[0].runId),
      false,
      'exit withdraws active control before delayed close'
    )
    assert.equal(
      f.events.some((event) => event.kind === 'complete'),
      false,
      'real inherited pipe is still open'
    )
    const first = f.control.cancel(),
      duplicate = f.control.cancel()
    assert.equal(first, duplicate)
    assert.notEqual((await first).state, 'cancelled')
    const result = await f.execution
    assert.equal(result.success, true)
    assert.equal(result.result.status, 'available')
    assert.equal(result.result.value, false)
    assert.equal(
      f.events.filter((event) => event.kind === 'complete').length,
      1
    )
    assert.equal(
      f.events.filter((event) => event.kind === 'cancelled').length,
      0
    )
  }
)

test(
  'real Sails child exposes bounded live snapshots and confirms termination of its owned group',
  { skip: process.platform !== 'linux', timeout: 15000 },
  async (t) => {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-owned-'))
    t.after(() => fs.rmSync(appPath, { recursive: true, force: true }))
    fs.mkdirSync(path.join(appPath, 'scripts'))
    fs.symlinkSync(
      path.resolve('node_modules'),
      path.join(appPath, 'node_modules')
    )
    fs.writeFileSync(path.join(appPath, 'package.json'), '{"scripts":{}}')
    fs.writeFileSync(
      path.join(appPath, 'scripts', 'slow.js'),
      `module.exports={friendlyName:'Owned slow fixture',habitat:'none',inputs:{},fn:async()=>{console.log('synthetic root ready '+process.pid);let n=0;require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('synthetic descendant ready '+process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});setInterval(()=>console.log('synthetic '+n++),50);await new Promise(r=>setTimeout(r,10000));return false}}`
    )
    const sails = new EventEmitter()
    const diagnostics = []
    sails.log = {
      error() {},
      warn: (...args) => diagnostics.push(args.join(' '))
    }
    const events = []
    for (const name of [
      'start',
      'log',
      'cancelling',
      'cancelled',
      'error',
      'complete',
      'unconfirmed'
    ])
      sails.on('quest:job:' + name, (event) =>
        events.push({ kind: name, ...event })
      )
    const cleanupIdentities = new Map()
    t.after(() => {
      const runId = events.find((event) => event.kind === 'start')?.runId
      for (const [pid, ticks] of cleanupIdentities) {
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
          if (
            stat
              .slice(stat.lastIndexOf(')') + 1)
              .trim()
              .split(/\s+/)[0] === 'Z'
          )
            continue
          assert.equal(
            stat
              .slice(stat.lastIndexOf(')') + 1)
              .trim()
              .split(/\s+/)[19],
            ticks
          )
          assert.ok(
            fs
              .readFileSync(`/proc/${pid}/environ`, 'utf8')
              .split('\0')
              .includes(`QUEST_OWNED_RUN_ID=${runId}`)
          )
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
        }
      }
    })
    const sink = () =>
      new Writable({
        write(chunk, _encoding, done) {
          diagnostics.push(chunk.toString())
          const runId = events.find((event) => event.kind === 'start')?.runId
          for (const match of diagnostics
            .join('')
            .matchAll(/synthetic (?:root|descendant) ready (\d+)/g)) {
            const pid = Number(match[1])
            if (cleanupIdentities.has(pid)) continue
            try {
              if (
                !fs
                  .readFileSync(`/proc/${pid}/environ`, 'utf8')
                  .split('\0')
                  .includes(`QUEST_OWNED_RUN_ID=${runId}`)
              )
                continue
              const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
              cleanupIdentities.set(
                pid,
                stat
                  .slice(stat.lastIndexOf(')') + 1)
                  .trim()
                  .split(/\s+/)[19]
              )
            } catch (error) {
              if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
            }
          }
          done()
        }
      })
    const runtime = createRuntime()
    const execution = executeJob(
      'slow',
      { inputSchema: {} },
      {},
      {
        sails,
        runtime,
        running: new Map(),
        stdout: sink(),
        stderr: sink(),
        config: { appPath, runtimeControls: true, logBytes: 1024 }
      }
    )
    const outcome = execution.catch((error) => error)
    const deadline = Date.now() + 10000
    while (
      !events.some(
        (event) =>
          event.kind === 'log' &&
          event.logs.stdout.includes('synthetic descendant ready')
      ) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50))
    const start = events.find((event) => event.kind === 'start')
    const control = runtime.controls.get(start.runId)
    assert.ok(
      control,
      'actual spawned child ownership was recorded: ' + diagnostics.join('')
    )
    assert.ok(events.some((event) => event.kind === 'log'))
    const cancelStartedAt = Date.now()
    const cancellation = await control.cancel()
    assert.deepEqual(cancellation, { state: 'cancelled', confirmed: true })
    assert.ok(
      Date.now() - cancelStartedAt >= 1900,
      'TERM-resistant descendant required the checked KILL phase'
    )
    assert.equal((await outcome).state, 'cancelled')
    assert.equal(events.filter((event) => event.kind === 'cancelled').length, 1)
    assert.equal(events.filter((event) => event.kind === 'complete').length, 0)
    assert.equal(runtime.active.size, 0)
    assert.equal(runtime.controls.size, 0)
    for (const event of events.filter((event) => event.kind === 'log'))
      assert.ok(Buffer.byteLength(event.logs.stdout) <= 1024)
  }
)

test(
  'duplicate cancellation coalesces and a TERM-resistant owned child is confirmed only after KILL',
  { skip: process.platform !== 'linux', timeout: 12000 },
  async (t) => {
    const { spawn } = require('node:child_process')
    const { ownProcess } = require('../lib/core/owned-process')
    const runId = require('node:crypto').randomUUID()
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"
      ],
      {
        detached: true,
        env: { ...process.env, QUEST_OWNED_RUN_ID: runId },
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    await new Promise((resolve) => child.stdout.once('data', resolve))
    t.after(() => child.kill('SIGKILL'))
    const control = ownProcess(child, runId)
    const first = control.cancel(),
      second = control.cancel()
    assert.equal(first, second)
    const result = await first
    assert.equal(result.confirmed, true, JSON.stringify(result))
  }
)

test(
  'a forged or reused PID identity cannot signal an unrelated process',
  { skip: process.platform !== 'linux', timeout: 5000 },
  async (t) => {
    const { spawn } = require('node:child_process')
    const { ownProcess } = require('../lib/core/owned-process')
    const runId = require('node:crypto').randomUUID()
    const child = spawn(
      process.execPath,
      ['-e', "console.log('ready');setInterval(()=>{},1000)"],
      {
        detached: true,
        env: { ...process.env, QUEST_OWNED_RUN_ID: runId },
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    await new Promise((resolve) => child.stdout.once('data', resolve))
    t.after(() => child.kill('SIGKILL'))
    assert.throws(() => ownProcess(child, 'foreign-run'), /ownership/)
    const control = ownProcess(child, runId)
    const read = fs.readFileSync
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      const body = read(file, ...args)
      if (file !== `/proc/${child.pid}/stat`) return body
      const edge = body.lastIndexOf(')') + 1,
        fields = body.slice(edge).trim().split(/\s+/)
      fields[19] = String(Number(fields[19]) + 1)
      return body.slice(0, edge) + ' ' + fields.join(' ')
    })
    const kill = process.kill
    let signals = 0
    t.mock.method(process, 'kill', (...args) => {
      signals++
      return kill(...args)
    })
    assert.equal((await control.cancel()).confirmed, false)
    assert.equal(signals, 0)
  }
)

test(
  'escaped tagged descendants leave cancellation unconfirmed without signalling their new group',
  { skip: process.platform !== 'linux', timeout: 12000 },
  async (t) => {
    const { spawn } = require('node:child_process')
    const { ownProcess } = require('../lib/core/owned-process')
    const runId = require('node:crypto').randomUUID()
    const source = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:process.env});console.log(c.pid);setInterval(()=>{},1000)`
    const child = spawn(process.execPath, ['-e', source], {
      detached: true,
      env: { ...process.env, QUEST_OWNED_RUN_ID: runId },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    t.after(() => child.kill('SIGKILL'))
    const escapedPid = Number(
      (await new Promise((resolve) => child.stdout.once('data', resolve)))
        .toString()
        .trim()
    )
    const originalStat = fs.readFileSync(`/proc/${escapedPid}/stat`, 'utf8')
    const startTicks = originalStat
      .slice(originalStat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/)[19]
    t.after(() => {
      try {
        const current = fs.readFileSync(`/proc/${escapedPid}/stat`, 'utf8')
        assert.equal(
          current
            .slice(current.lastIndexOf(')') + 1)
            .trim()
            .split(/\s+/)[19],
          startTicks
        )
        assert.ok(
          fs
            .readFileSync(`/proc/${escapedPid}/environ`, 'utf8')
            .split('\0')
            .includes(`QUEST_OWNED_RUN_ID=${runId}`)
        )
        process.kill(escapedPid, 'SIGKILL')
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
      }
    })
    const control = ownProcess(child, runId)
    assert.deepEqual(await control.cancel(), {
      state: 'unconfirmed',
      confirmed: false
    })
    assert.equal(process.kill(escapedPid, 0), true)
  }
)

test(
  'unreadable live members and unknown group identity never count as terminated or receive a signal',
  { skip: process.platform !== 'linux', timeout: 5000 },
  async (t) => {
    const { spawn } = require('node:child_process')
    const { ownProcess } = require('../lib/core/owned-process')
    const runId = require('node:crypto').randomUUID()
    const child = spawn(
      process.execPath,
      ['-e', "console.log('ready');setInterval(()=>{},1000)"],
      {
        detached: true,
        env: { ...process.env, QUEST_OWNED_RUN_ID: runId },
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    await new Promise((resolve) => child.stdout.once('data', resolve))
    t.after(() => child.kill('SIGKILL'))
    const unreadable = ownProcess(child, runId),
      unknown = ownProcess(child, runId)
    const read = fs.readFileSync
    let unknownGroup = false,
      signals = 0
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (
        file === `/proc/${child.pid}/environ` ||
        (unknownGroup && file === `/proc/${child.pid}/stat`)
      )
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return read(file, ...args)
    })
    t.mock.method(process, 'kill', () => {
      signals++
    })
    assert.equal((await unreadable.cancel()).confirmed, false)
    unknownGroup = true
    assert.equal((await unknown.cancel()).confirmed, false)
    assert.equal(signals, 0)
  }
)

test(
  'an unreadable same-UID process outside the group cannot establish escaped descendant termination',
  { skip: process.platform !== 'linux', timeout: 5000 },
  async (t) => {
    const { spawn } = require('node:child_process')
    const { ownProcess } = require('../lib/core/owned-process')
    const runId = require('node:crypto').randomUUID()
    const child = spawn(
      process.execPath,
      ['-e', "console.log('ready');setInterval(()=>{},1000)"],
      {
        detached: true,
        env: { ...process.env, QUEST_OWNED_RUN_ID: runId },
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    await new Promise((resolve) => child.stdout.once('data', resolve))
    t.after(() => child.kill('SIGKILL'))
    const control = ownProcess(child, runId),
      read = fs.readFileSync
    let signals = 0
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === `/proc/${child.pid}/environ`)
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      const body = read(file, ...args)
      if (file !== `/proc/${child.pid}/stat`) return body
      const edge = body.lastIndexOf(')') + 1,
        fields = body.slice(edge).trim().split(/\s+/)
      fields[2] = String(child.pid + 1)
      return body.slice(0, edge) + ' ' + fields.join(' ')
    })
    t.mock.method(process, 'kill', () => {
      signals++
    })
    assert.equal((await control.cancel()).confirmed, false)
    assert.equal(signals, 0)
  }
)

test(
  'only a positively observed zombie state permits ignoring an unreadable exited member',
  { skip: process.platform !== 'linux', timeout: 5000 },
  async (t) => {
    const { spawn } = require('node:child_process')
    const { ownProcess } = require('../lib/core/owned-process')
    const runId = require('node:crypto').randomUUID()
    const child = spawn(
      process.execPath,
      ['-e', "console.log('ready');setInterval(()=>{},1000)"],
      {
        detached: true,
        env: { ...process.env, QUEST_OWNED_RUN_ID: runId },
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    await new Promise((resolve) => child.stdout.once('data', resolve))
    t.after(() => child.kill('SIGKILL'))
    const control = ownProcess(child, runId),
      read = fs.readFileSync
    let signals = 0
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === `/proc/${child.pid}/environ`)
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      const body = read(file, ...args)
      if (file !== `/proc/${child.pid}/stat`) return body
      const edge = body.lastIndexOf(')') + 1,
        fields = body.slice(edge).trim().split(/\s+/)
      fields[0] = 'Z'
      return body.slice(0, edge) + ' ' + fields.join(' ')
    })
    t.mock.method(process, 'kill', () => {
      signals++
    })
    assert.equal((await control.cancel()).confirmed, true)
    assert.equal(signals, 0)
  }
)

test(
  'public resident Quest cancellation admits synchronously and confirms its exact active run',
  { skip: process.platform !== 'linux', timeout: 15000 },
  async (t) => {
    const appPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'quest-public-owned-')
    )
    fs.mkdirSync(path.join(appPath, 'scripts'))
    fs.symlinkSync(
      path.resolve('node_modules'),
      path.join(appPath, 'node_modules')
    )
    fs.writeFileSync(path.join(appPath, 'package.json'), '{"scripts":{}}')
    fs.writeFileSync(
      path.join(appPath, 'scripts', 'public-slow.js'),
      `module.exports={friendlyName:'Public owned fixture',habitat:'none',inputs:{},fn:async()=>{console.log('public owned ready');await new Promise(r=>setTimeout(r,10000))}}`
    )
    const app = new (require('sails').Sails)()
    t.after(async () => {
      await new Promise((resolve) => app.lower(resolve))
      fs.rmSync(appPath, { recursive: true, force: true })
    })
    await new Promise((resolve, reject) =>
      app.load(
        {
          appPath,
          environment: 'test',
          log: { level: 'silent' },
          hooks: {
            quest: require('../lib'),
            orm: false,
            grunt: false,
            session: false,
            sockets: false
          },
          quest: { autoStart: false, runtimeControls: true },
          globals: { sails: false, _: false, async: false, models: false }
        },
        (error) => (error ? reject(error) : resolve())
      )
    )
    const events = []
    for (const kind of [
      'start',
      'log',
      'cancelling',
      'cancelled',
      'unconfirmed'
    ])
      app.on('quest:job:' + kind, (event) => events.push({ kind, ...event }))
    const execution = app.quest.run('public-slow').catch((error) => error)
    const deadline = Date.now() + 10000
    while (
      !events.some(
        (event) =>
          event.kind === 'log' &&
          event.logs.stdout.includes('public owned ready')
      ) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(
      events.some(
        (event) =>
          event.kind === 'log' &&
          event.logs.stdout.includes('public owned ready')
      ),
      'real public job reached its running log checkpoint'
    )
    const start = events.find((event) => event.kind === 'start')
    assert.ok(start)
    const pending = app.quest.cancel(start.runId)
    assert.equal(
      events.filter((event) => event.kind === 'cancelling').length,
      1,
      'public cancellation admission is recorded before returning its promise'
    )
    assert.equal((await pending).confirmed, true)
    await execution
    assert.equal(events.filter((event) => event.kind === 'cancelled').length, 1)
    assert.equal(app.quest.isRunning('public-slow'), false)
  }
)
