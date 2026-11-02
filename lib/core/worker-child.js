// @ts-check
// Dedicated execution process, never the HTTP process or another scheduler.
const path = require('node:path')
const { encodeResult, byteLimit } = require('./result')
require('./execution-child').markExecutionChild()
const generation = process.env.QUEST_WORKER_GENERATION
const appPath = process.env.QUEST_WORKER_APP_PATH
if (!generation || !appPath || !process.send) process.exit(1)
/** @type {any} */
let active = null
let draining = false
let lowering = false
let app
/** @param {any} message @param {(error?: Error|null) => void} [callback] */
const send = (message, callback = () => {}) => {
  if (!process.connected) return callback(new Error('Worker IPC disconnected'))
  process.send({ generation, ...message }, callback)
}
function append(channel, chunk, encoding, callback) {
  if (typeof encoding === 'function') callback = encoding
  if (active) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(
          String(chunk),
          /** @type {BufferEncoding} */ (
            typeof encoding === 'string' ? encoding : 'utf8'
          )
        )
    active[channel + 'Bytes'] += buffer.length
    const previous = active[channel]
    active[channel] =
      buffer.length >= active.logBytes
        ? Buffer.from(buffer.subarray(-active.logBytes))
        : Buffer.concat([previous, buffer]).subarray(-active.logBytes)
    active.dirty = true
  }
  if (callback) process.nextTick(callback)
  return true
}
// Attribute output to a specific run, bound it before IPC, and ignore orphan
// output between runs. Reusable jobs must await all their own work.
process.stdout.write = /** @type {any} */ (
  (chunk, encoding, callback) => append('stdout', chunk, encoding, callback)
)
process.stderr.write = /** @type {any} */ (
  (chunk, encoding, callback) => append('stderr', chunk, encoding, callback)
)
function logs(run) {
  return {
    stdout: run.stdout.toString('utf8'),
    stderr: run.stderr.toString('utf8'),
    stdoutTruncated: run.stdoutBytes > run.logBytes,
    stderrTruncated: run.stderrBytes > run.logBytes,
    limitBytes: run.logBytes
  }
}
async function shutdown() {
  draining = true
  if (active || lowering) return
  lowering = true
  if (app) app.lower(() => process.exit(0))
  else process.exit(0)
}
async function run(message) {
  if (draining || active || typeof message.runId !== 'string') return
  if (
    !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(message.script) ||
    message.script.includes('..')
  )
    return shutdown()
  const state = {
    runId: message.runId,
    logBytes: byteLimit(message.logBytes),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutBytes: 0,
    stderrBytes: 0,
    dirty: false,
    sending: false
  }
  active = state
  const timer = setInterval(() => {
    if (!state.dirty || state.sending || active !== state) return
    state.dirty = false
    state.sending = true
    send({ type: 'logs', runId: state.runId, logs: logs(state) }, () => {
      state.sending = false
    })
  }, 250)
  timer.unref()
  let result
  let failure
  try {
    const definition = require(
      path.resolve(
        appPath,
        process.env.QUEST_WORKER_SCRIPTS_DIR || 'scripts',
        message.script + '.js'
      )
    )
    const machine = require(require.resolve('machine', { paths: [appPath] }))
    const wet = machine.buildWithCustomUsage({
      def: definition,
      implementationSniffingTactic: 'analogOrClassical',
      extraArginsTactic: 'error'
    })
    // Validate in the actual warmed application's machine runner again. The
    // parent already validated before start; business fn performs real claims.
    send({ type: 'accepted', runId: state.runId })
    const value = await new Promise((resolve, reject) => {
      wet(message.inputs)
        .meta({ sails: app, serialCommandLineArgs: [] })
        .exec((error, value) => (error ? reject(error) : resolve(value)))
    })
    result = encodeResult(value, byteLimit(message.resultBytes))
  } catch (error) {
    if (error.name === 'Exception' && typeof error.exit === 'string') {
      result = encodeResult(error.raw, byteLimit(message.resultBytes))
      result.exit = error.exit.slice(0, 128)
    } else {
      result = { status: 'undefined' }
      failure = {
        message: String(error.message || 'Worker failed').slice(0, 4096),
        stack: String(error.stack || '').slice(0, 16384),
        code:
          typeof error.code === 'string' ? error.code.slice(0, 128) : undefined
      }
    }
  } finally {
    clearInterval(timer)
  }
  delete result.json
  const packet = {
    type: 'complete',
    runId: state.runId,
    result,
    logs: logs(state),
    error: failure
  }
  active = null
  send(packet, () => {
    if (draining || failure) shutdown()
  })
}
process.on('message', (/** @type {any} */ message) => {
  if (!message || message.generation !== generation) return
  if (message.type === 'shutdown') return shutdown()
  if (message.type === 'run') run(message).catch(() => process.exit(1))
})
process.on('disconnect', () => process.exit(1))
;(async () => {
  const Sails = require(require.resolve('sails', { paths: [appPath] })).Sails
  app = new Sails()
  await new Promise((resolve, reject) =>
    app.load(
      {
        ...app.getRc(),
        environment: process.env.NODE_ENV || 'console',
        quest: { autoStart: false }
      },
      (error) => (error ? reject(error) : resolve())
    )
  )
  if (draining) return shutdown()
  send({ type: 'ready' })
})().catch((error) =>
  send(
    {
      type: 'boot_error',
      error: {
        message: String(error.message || 'Sails startup failed').slice(0, 4096),
        stack: String(error.stack || '').slice(0, 16384)
      }
    },
    () => process.exit(1)
  )
)
