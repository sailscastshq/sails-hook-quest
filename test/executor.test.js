const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Writable } = require('node:stream')
const { createRuntime, createTestApi } = require('sounding')

const { createDiagnosticTail, executeJob } = require('../lib/core/executor')

const sails = new EventEmitter()
sails.config = {
  appPath: process.cwd(),
  environment: 'test',
  datastores: {}
}
sails.hooks = {}
sails.helpers = {}
sails.models = {}
sails.log = { info() {}, warn() {}, error() {}, verbose() {} }

const test = createTestApi({ runtime: createRuntime(sails) })

test('failed jobs keep live output and emit bounded diagnostics', async ({
  expect,
  t
}) => {
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

  let executionError
  try {
    await executeJob(
      'send-issue-notifications',
      { name: 'send-issue-notifications' },
      {},
      {
        config: { appPath, sailsPath: runnerPath, diagnosticTailBytes: 1024 },
        stdout: output,
        stderr: output
      }
    )
  } catch (error) {
    executionError = error
  }

  const event = await failure
  expect(executionError.message).toContain('exited with code 1')
  expect(liveOutput).toContain('Preparing notifications')
  expect(liveOutput).toContain('database exploded')
  expect(event.error.diagnostic).toContain('sendIssueNotifications')
  expect(event.error.stack).toContain('executor.js')
})

test('diagnostic tails discard old output at the configured byte limit', ({
  expect
}) => {
  const tail = createDiagnosticTail(12)
  tail.append('discard-this-')
  tail.append('keep-this')

  expect(Buffer.byteLength(tail.value())).toBe(12)
  expect(tail.value()).toBe('is-keep-this')
})
