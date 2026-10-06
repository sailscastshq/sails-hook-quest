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
    fs.writeFileSync(path.join(appPath, 'package.json'), '{}')
    fs.writeFileSync(
      path.join(appPath, 'scripts', 'slow.js'),
      `module.exports={friendlyName:'Owned slow fixture',habitat:'none',inputs:{},fn:async()=>{let n=0;setInterval(()=>console.log('synthetic '+n++),50);await new Promise(r=>setTimeout(r,10000));return false}}`
    )
    const sails = new EventEmitter()
    sails.log = { error() {} }
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
      sails.on('quest:job:' + name, (event) => events.push({ name, ...event }))
    const sink = () =>
      new Writable({
        write(_chunk, _encoding, done) {
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
          event.name === 'log' && event.logs.stdout.includes('synthetic')
      ) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50))
    const start = events.find((event) => event.name === 'start')
    const control = runtime.controls.get(start.runId)
    assert.ok(control, 'actual spawned child ownership was recorded')
    assert.ok(events.some((event) => event.name === 'log'))
    const cancellation = await control.cancel()
    assert.deepEqual(cancellation, { state: 'cancelled', confirmed: true })
    assert.equal((await outcome).state, 'cancelled')
    assert.equal(events.filter((event) => event.name === 'cancelled').length, 1)
    assert.equal(events.filter((event) => event.name === 'complete').length, 0)
    assert.equal(runtime.active.size, 0)
    assert.equal(runtime.controls.size, 0)
    for (const event of events.filter((event) => event.name === 'log'))
      assert.ok(Buffer.byteLength(event.logs.stdout) <= 1024)
  }
)

test(
  'duplicate cancellation coalesces and a TERM-resistant owned child is confirmed only after KILL',
  { skip: process.platform !== 'linux', timeout: 12000 },
  async () => {
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
        env: { ...process.env, QUEST_RUN_ID: runId },
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    await new Promise((resolve) => child.stdout.once('data', resolve))
    const control = ownProcess(child, runId)
    const first = control.cancel(),
      second = control.cancel()
    assert.equal(first, second)
    assert.equal((await first).confirmed, true)
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
        env: { ...process.env, QUEST_RUN_ID: runId },
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
