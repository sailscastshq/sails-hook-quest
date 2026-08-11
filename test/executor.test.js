const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Writable } = require('node:stream')
const test = require('node:test')

const { createDiagnosticTail, executeJob } = require('../lib/core/executor')

test('failed jobs keep live output and emit bounded diagnostics', async (t) => {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-diagnostics-'))
  const scriptsPath = path.join(appPath, 'scripts')
  const runnerPath = path.join(appPath, 'fake-sails')
  fs.mkdirSync(scriptsPath)
  fs.writeFileSync(path.join(scriptsPath, 'send-issue-notifications.js'), '')
  fs.writeFileSync(
    runnerPath,
    [
      '#!/usr/bin/env node',
      "process.stdout.write('Preparing notifications\\n')",
      "process.stderr.write('Error: database exploded\\n    at sendIssueNotifications (/app/scripts/send-issue-notifications.js:12:3)\\n')",
      'process.exitCode = 1'
    ].join('\n')
  )
  fs.chmodSync(runnerPath, 0o755)

  const previousSails = global.sails
  const sails = new EventEmitter()
  sails.log = { info() {}, warn() {}, error() {}, verbose() {} }
  global.sails = sails

  let liveOutput = ''
  const output = new Writable({
    write(chunk, encoding, callback) {
      liveOutput += chunk.toString()
      callback()
    }
  })
  const failure = new Promise((resolve) =>
    sails.once('quest:job:error', resolve)
  )

  t.after(() => {
    global.sails = previousSails
    fs.rmSync(appPath, { recursive: true, force: true })
  })

  await assert.rejects(
    executeJob(
      'send-issue-notifications',
      { name: 'send-issue-notifications' },
      {},
      {
        config: { appPath, sailsPath: runnerPath, diagnosticTailBytes: 1024 },
        stdout: output,
        stderr: output
      }
    ),
    /exited with code 1/
  )

  const event = await failure
  assert.match(liveOutput, /Preparing notifications/)
  assert.match(liveOutput, /database exploded/)
  assert.match(event.error.diagnostic, /sendIssueNotifications/)
  assert.match(event.error.stack, /executor\.js/)
})

test('diagnostic tails discard old output at the configured byte limit', () => {
  const tail = createDiagnosticTail(12)
  tail.append('discard-this-')
  tail.append('keep-this')

  assert.equal(Buffer.byteLength(tail.value()), 12)
  assert.equal(tail.value(), 'is-keep-this')
})
