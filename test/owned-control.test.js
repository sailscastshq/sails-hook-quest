const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Writable } = require('node:stream')
const { executeJob } = require('../lib/core/executor')
const { createRuntime } = require('../lib/core/runtime')

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
