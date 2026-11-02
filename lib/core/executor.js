// @ts-check
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { getGlobalSails } = require('./global-sails')
const { createRuntime } = require('./runtime')
const { encodeResult, byteLimit } = require('./result')
const DEFAULT_DIAGNOSTIC_TAIL_BYTES = 64 * 1024
const runtimes = new WeakMap()
const { ownProcess } = require('./owned-process')
const { checkScheduledAdmission } = require('./admission')
const { WorkerPool } = require('./worker-pool')
const { executeWorkerLease } = require('./worker-executor')

/** @typedef {import('../types').AnyRecord} AnyRecord */
/** @typedef {import('../types').QuestExecutableJob} QuestExecutableJob */
/** @typedef {import('../types').QuestExecutionResult} QuestExecutionResult */
/** @typedef {import('../types').QuestExecutorContext} QuestExecutorContext */

/** Validate with the application's installed Sails machine runner, without invoking business code.
 * @param {AnyRecord} schema @param {AnyRecord} inputs @param {string} cwd
 */
function validateInputs(schema, inputs, cwd) {
  if (!Object.keys(schema).length && !Object.keys(inputs).length) return
  const machine = require(require.resolve('machine', { paths: [cwd] }))
  return machine
    .buildWithCustomUsage({
      def: {
        identity: 'quest-input-validation',
        sync: true,
        inputs: schema,
        fn: function (normalizedInputs, exits) {
          return exits.success(normalizedInputs)
        }
      },
      extraArginsTactic: 'error'
    })(inputs)
    .execSync()
}

/** @param {string} name @param {QuestExecutableJob} job @param {AnyRecord} [customInputs] @param {QuestExecutorContext} [context]
 * @returns {Promise<QuestExecutionResult>}
 */
async function executeJob(name, job, customInputs = {}, context = {}) {
  const { running = new Map(), config = {} } = context
  const sourceJob = job
  job = {
    ...job,
    execution:
      job.execution === undefined
        ? config.execution === undefined
          ? 'worker'
          : config.execution
        : job.execution
  }
  let runtime = context.runtime || runtimes.get(running)
  if (!runtime) {
    runtime = createRuntime()
    runtimes.set(running, runtime)
  }
  const runId = randomUUID()
  const startedAt = new Date()
  const identity = {
    runId,
    runtimeId: runtime.runtimeId,
    startedAt,
    trigger: context.trigger || 'manual'
  }
  const sails = context.sails || getGlobalSails()
  const emit = (event, data) => {
    const payload = { ...identity, ...data, sequence: ++runtime.sequence }
    if (sails) {
      try {
        sails.emit(event, payload)
      } catch (error) {
        sails.log.error('Quest lifecycle listener failed:', error)
      }
    }
    return payload
  }
  if (
    (job.withoutOverlapping &&
      (running.has(name) || runtime.admissions?.has(name))) ||
    job.paused ||
    (context.trigger === 'scheduled' &&
      job.when &&
      runtime.admissions?.has(name))
  ) {
    const reason = job.paused
      ? 'paused'
      : runtime.admissions?.has(name)
        ? 'admission_pending'
        : 'already_running'
    emit('quest:job:skip', { name, reason, timestamp: new Date() })
    return { skipped: true, reason, ...identity, finishedAt: new Date() }
  }
  const cwd = config.appPath || process.cwd()
  const scriptsDir = config.scriptsDir || 'scripts'
  const script = job.script || name
  let inputs
  let admissionInputs
  let workerPool
  let args
  let scriptPath
  let inputJson
  try {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(script) || script.includes('..'))
      throw new Error('Invalid Quest script identity')
    inputs = {
      ...(job.inputs || {}),
      ...(job.scriptInputs || {}),
      ...customInputs
    }
    const encoded = encodeResult(inputs, byteLimit(config.inputBytes))
    if (encoded.status !== 'available')
      throw new Error(`Quest inputs: ${encoded.status}`)
    inputJson = encoded.json
    if (job.execution && !['isolated', 'worker'].includes(job.execution))
      throw new Error('Unknown Quest execution mode')
    if (job.execution === 'worker' && config.executionChild)
      throw new Error(
        'Reusable worker execution cannot be nested in an execution child'
      )
    if (job.when !== undefined && typeof job.when !== 'function')
      throw new Error('Quest when must be a function')
    if (
      job.executionTimeoutMs !== undefined &&
      (!Number.isSafeInteger(job.executionTimeoutMs) ||
        job.executionTimeoutMs <= 0 ||
        job.executionTimeoutMs > 3600000)
    )
      throw new Error('executionTimeoutMs must be a positive integer')
    admissionInputs = job.inputSchema
      ? validateInputs(job.inputSchema, inputs, cwd) || inputs
      : inputs
    if (job.execution === 'worker')
      workerPool =
        runtime.workerPool || (runtime.workerPool = new WorkerPool(config))
    args = buildCommandArgs(script, inputs, job.inputSchema)
    scriptPath = path.resolve(cwd, scriptsDir, `${script}.js`)
    if (!fs.existsSync(scriptPath))
      throw new Error(
        `Job "${name}" not found. Please check that the script exists at ${scriptsDir}/${script}.js`
      )
    scriptPath = fs.realpathSync(scriptPath)
  } catch (error) {
    const validationCode =
      typeof error.code === 'string' ? error.code : undefined
    Object.assign(error, identity, {
      code: 'E_QUEST_ADMISSION_REJECTED',
      validationCode,
      phase: 'validation',
      admission: 'rejected_before_start'
    })
    emit('quest:job:error', {
      name,
      inputs: inputs || {},
      error: {
        message: error.message,
        stack: error.stack,
        admissionCode: error.code,
        validationCode
      },
      admission: 'rejected_before_start',
      duration: 0,
      timestamp: new Date(),
      finishedAt: new Date(),
      phase: 'validation'
    })
    throw error
  }

  if (context.trigger === 'scheduled' && job.when) {
    const admitted = await checkScheduledAdmission(
      { ...job, name },
      admissionInputs,
      { ...context, runtime, sails },
      identity,
      emit
    )
    if (
      !admitted ||
      sourceJob.paused ||
      runtime.draining ||
      (job.withoutOverlapping && running.has(name))
    ) {
      const reason = !admitted
        ? 'no_work'
        : sourceJob.paused
          ? 'paused'
          : runtime.draining
            ? 'draining'
            : 'already_running'
      const finishedAt = new Date()
      emit('quest:job:skip', { name, reason, timestamp: finishedAt })
      return { skipped: true, reason, ...identity, finishedAt }
    }
  }
  if (runtime.draining) {
    const finishedAt = new Date()
    emit('quest:job:skip', { name, reason: 'draining', timestamp: finishedAt })
    return { skipped: true, reason: 'draining', ...identity, finishedAt }
  }
  let workerLease
  if (job.execution === 'worker') {
    workerLease = workerPool.acquire(runId)
    if (!workerLease) {
      const finishedAt = new Date()
      emit('quest:job:skip', {
        name,
        reason: 'worker_busy',
        timestamp: finishedAt
      })
      return { skipped: true, reason: 'worker_busy', ...identity, finishedAt }
    }
  } else if (job.execution && job.execution !== 'isolated') {
    throw Object.assign(new Error('Unknown Quest execution mode'), identity, {
      code: 'E_QUEST_ADMISSION_REJECTED',
      admission: 'rejected_before_start',
      phase: 'validation'
    })
  }
  const active = runtime.active.get(name) || new Map()
  active.set(runId, startedAt.getTime())
  runtime.active.set(name, active)
  running.set(name, Math.min(...active.values()))
  const release = () => {
    active.delete(runId)
    if (active.size) running.set(name, Math.min(...active.values()))
    else {
      runtime.active.delete(name)
      running.delete(name)
    }
  }
  emit('quest:job:start', {
    name,
    inputs,
    timestamp: startedAt,
    ...(workerLease
      ? {
          execution: 'worker',
          workerGeneration: workerLease.generation,
          phase: workerLease.phase
        }
      : {})
  })
  if (workerLease)
    return executeWorkerLease(
      workerLease,
      { ...job, name },
      inputs,
      { ...context, runtime, config },
      identity,
      emit,
      release
    )
  const env = { ...process.env }
  if (config.environment) env.NODE_ENV = config.environment
  env.QUEST_SCRIPT_PATH = scriptPath
  env.QUEST_RUN_ID = runId
  if (config.runtimeControls === true && process.platform === 'linux')
    env.QUEST_OWNED_RUN_ID = runId
  env.QUEST_RESULT_BYTES = String(byteLimit(config.resultBytes))
  env.NODE_OPTIONS =
    `${env.NODE_OPTIONS || ''} --require ${JSON.stringify(path.join(__dirname, 'child-result.js'))}`.trim()
  const diagnostic = createDiagnosticTail(config.diagnosticTailBytes)
  const stdout = createDiagnosticTail(byteLimit(config.logBytes))
  const stderr = createDiagnosticTail(byteLimit(config.logBytes))
  let stdoutBytes = 0
  let stderrBytes = 0
  const logs = (live = false) => ({
    stdout: stdout.value(live),
    stderr: stderr.value(live),
    stdoutTruncated: stdoutBytes > byteLimit(config.logBytes),
    stderrTruncated: stderrBytes > byteLimit(config.logBytes),
    limitBytes: byteLimit(config.logBytes)
  })

  return new Promise((resolve, reject) => {
    let child
    let settled = false
    let ownership
    let logTimer
    let ownershipTimer
    let dirtyLogs = false
    const controlsEnabled =
      config.runtimeControls === true && process.platform === 'linux'
    const publishLogs = () => {
      if (!controlsEnabled || !dirtyLogs || settled) return
      dirtyLogs = false
      emit('quest:job:log', {
        name,
        inputs,
        logs: logs(true),
        timestamp: new Date()
      })
    }
    let resultBuffer = Buffer.alloc(0)
    let resultOverflow = false
    const finish = async (error, code, signal = null) => {
      if (settled) return
      publishLogs()
      settled = true
      clearInterval(logTimer)
      clearInterval(ownershipTimer)
      const cancellation = ownership?.requested ? await ownership.pending : null
      let completedEnvelope = false
      if (!error && code === 0 && !resultOverflow && resultBuffer.length) {
        try {
          const envelope = JSON.parse(resultBuffer.toString('utf8'))
          completedEnvelope =
            envelope.version === 1 &&
            envelope.runId === runId &&
            (envelope.result?.status !== 'available' ||
              Object.prototype.hasOwnProperty.call(envelope.result, 'value')) &&
            [
              'available',
              'undefined',
              'too_large',
              'serialization_error'
            ].includes(envelope.result?.status)
        } catch {
          /* Invalid result transport cannot prove business completion. */
        }
      }
      const cancelledExecution =
        cancellation &&
        cancellation.state !== 'exited' &&
        !cancellation.notAdmitted &&
        !(cancellation.confirmed && completedEnvelope)
      const finishedAt = new Date()
      const duration = finishedAt.getTime() - startedAt.getTime()
      runtime.controls.delete(runId)
      if (!cancelledExecution || cancellation.confirmed) release()
      const terminal = {
        name,
        inputs,
        duration,
        timestamp: finishedAt,
        finishedAt,
        logs: logs(),
        exitCode: typeof code === 'number' ? code : null,
        signal: typeof signal === 'string' ? signal : null
      }
      if (cancelledExecution) {
        const state = cancellation.confirmed ? 'cancelled' : 'unconfirmed'
        const event = emit(`quest:job:${state}`, {
          ...terminal,
          cancellationConfirmed: cancellation.confirmed
        })
        const failure = Object.assign(
          new Error(
            cancellation.confirmed
              ? 'The owned process group was terminated.'
              : 'Owned termination is unconfirmed; do not repeat this job.'
          ),
          identity,
          { state, sequence: event.sequence, ...terminal }
        )
        reject(failure)
      } else if (error || code !== 0) {
        const failure =
          error ||
          new Error(
            signal
              ? `Job "${name}" terminated by signal ${signal}`
              : `Job "${name}" exited with code ${code}`
          )
        const event = emit('quest:job:error', {
          ...terminal,
          error: {
            message: failure.message,
            code,
            stack: failure.stack,
            diagnostic: diagnostic.value()
          }
        })
        Object.assign(failure, identity, {
          finishedAt,
          duration,
          logs: terminal.logs,
          exitCode: terminal.exitCode,
          signal: terminal.signal,
          sequence: event.sequence
        })
        reject(failure)
      } else {
        /** @type {import('../types').QuestBusinessResult} */
        let result = { status: 'unsupported', reason: 'missing_transport' }
        if (resultOverflow)
          result = { status: 'too_large', reason: 'transport_limit' }
        else if (resultBuffer.length) {
          try {
            const envelope = JSON.parse(resultBuffer.toString('utf8'))
            if (envelope.version !== 1 || envelope.runId !== runId)
              throw new Error('mismatched_transport')
            if (
              ![
                'available',
                'undefined',
                'too_large',
                'serialization_error'
              ].includes(envelope.result?.status)
            )
              throw new Error('invalid_result')
            if (envelope.result.status === 'available') {
              if (
                !Object.prototype.hasOwnProperty.call(envelope.result, 'value')
              )
                throw new Error('missing_value')
              const encoded = encodeResult(
                envelope.result.value,
                config.resultBytes
              )
              result =
                encoded.status === 'available'
                  ? { status: 'available', value: encoded.value }
                  : { status: encoded.status }
            } else result = { status: envelope.result.status }
            if (
              typeof envelope.result.exit === 'string' &&
              envelope.result.exit.length <= 128
            )
              result.exit = envelope.result.exit
          } catch {
            result = { status: 'unsupported', reason: 'invalid_transport' }
          }
        }
        const event = emit('quest:job:complete', { ...terminal, result })
        resolve({
          success: true,
          duration,
          ...identity,
          finishedAt,
          sequence: event.sequence,
          result,
          logs: terminal.logs,
          exitCode: terminal.exitCode,
          signal: terminal.signal
        })
      }
    }
    try {
      child = spawn(config.sailsPath || './node_modules/.bin/sails', args, {
        cwd,
        env,
        detached: controlsEnabled,
        stdio: ['inherit', 'pipe', 'pipe', 'pipe', 'pipe']
      })
      if (controlsEnabled) {
        // The spawn event confirms exec succeeded; before it /proc can still
        // expose the fork parent's environment rather than this child's.
        child.once('spawn', () => {
          const deadline = Date.now() + 1000
          const capture = () => {
            if (settled || ownership) return clearInterval(ownershipTimer)
            try {
              ownership = ownProcess(child, runId)
              runtime.controls.set(runId, {
                cancel: () => {
                  const first = !ownership.requested
                  if (first)
                    emit('quest:job:cancelling', {
                      name,
                      timestamp: new Date()
                    })
                  const pending = ownership.cancel()
                  if (first)
                    pending.then((outcome) => {
                      if (!settled && outcome.state === 'unconfirmed')
                        emit('quest:job:unconfirmed', {
                          name,
                          inputs,
                          timestamp: new Date(),
                          logs: logs(),
                          cancellationConfirmed: false,
                          error: {
                            message:
                              'Owned termination is unconfirmed; do not repeat this job.'
                          }
                        })
                    })
                  return pending
                }
              })
              clearInterval(ownershipTimer)
            } catch (error) {
              if (Date.now() >= deadline) {
                clearInterval(ownershipTimer)
                sails?.log?.warn?.(
                  'Owned Quest cancellation is unavailable:',
                  error.message
                )
              }
            }
          }
          // Shebang launchers can cross another exec transition after spawn.
          // Bounded observation acquires authority only from positive evidence.
          ownershipTimer = setInterval(capture, 20)
          ownershipTimer.unref?.()
          capture()
        })
        logTimer = setInterval(publishLogs, 250)
        logTimer.unref?.()
      }
      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length
        stdout.append(chunk)
        dirtyLogs = true
      })
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length
        stderr.append(chunk)
        dirtyLogs = true
      })
      teeChildOutput(child.stdout, context.stdout || process.stdout, diagnostic)
      teeChildOutput(child.stderr, context.stderr || process.stderr, diagnostic)
      const channel = /** @type {NodeJS.ReadableStream} */ (child.stdio[3])
      channel.on('data', (chunk) => {
        if (resultOverflow) return
        if (
          resultBuffer.length + chunk.length >
          byteLimit(config.resultBytes) + 1024
        ) {
          resultOverflow = true
          resultBuffer = Buffer.alloc(0)
          return
        }
        resultBuffer = Buffer.concat([resultBuffer, chunk])
      })
      channel.on('error', () => {
        resultOverflow = true
      })
      const inputChannel = /** @type {NodeJS.WritableStream} */ (child.stdio[4])
      inputChannel.on('error', () => {}) // Spawn failure/early exit is settled by close/error.
      inputChannel.end(inputJson)
      child.once('exit', () => {
        if (!ownership?.requested) runtime.controls.delete(runId)
      })
      child.once('close', (code, signal) => finish(null, code, signal))
      child.once('error', (error) => finish(error, null))
    } catch (error) {
      finish(error, null)
    }
  })
}

/**
 * Retain only the end of child output so a failed job can explain itself
 * without buffering an unbounded process log.
 *
 * @param {number} [requestedMaxBytes]
 */
function createDiagnosticTail(requestedMaxBytes) {
  const maxBytes =
    Number.isFinite(requestedMaxBytes) && requestedMaxBytes > 0
      ? Math.min(1024 * 1024, Math.floor(requestedMaxBytes))
      : DEFAULT_DIAGNOSTIC_TAIL_BYTES
  let buffer = Buffer.alloc(0)

  return {
    /** @param {Buffer|string} chunk */
    append(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (incoming.length >= maxBytes) {
        buffer = Buffer.from(incoming.subarray(incoming.length - maxBytes))
      } else {
        const keep = Math.max(0, maxBytes - incoming.length)
        buffer = Buffer.concat([
          buffer.subarray(Math.max(0, buffer.length - keep)),
          incoming
        ])
      }
    },
    value(preserveWhitespace = false) {
      let text = buffer.toString('utf8')
      if (!preserveWhitespace) text = text.trim()
      while (Buffer.byteLength(text) > maxBytes) text = text.slice(1)
      return text
    }
  }
}

/**
 * Mirror child output to the parent while retaining a bounded diagnostic tail.
 *
 * @param {NodeJS.ReadableStream|null} source
 * @param {NodeJS.WritableStream} destination
 * @param {ReturnType<typeof createDiagnosticTail>} diagnosticTail
 */
function teeChildOutput(source, destination, diagnosticTail) {
  if (!source) {
    return
  }

  source.on('data', (chunk) => {
    diagnosticTail.append(chunk)
    if (!destination.write(chunk)) {
      source.pause()
      destination.once('drain', () => source.resume())
    }
  })
}

/**
 * Build command arguments for sails run
 * @param {String} scriptName - Name of the script
 * @param {AnyRecord} [inputs] - Input values
 * @param {import('../types').QuestMachineInputs} [schema] Loaded input types for CLI encoding
 * @returns {string[]} Command arguments
 */
function buildCommandArgs(scriptName, inputs = {}, schema = {}) {
  const args = ['run', scriptName]

  // Add inputs as command line args
  for (const [key, value] of Object.entries(inputs)) {
    // Whelk checks JSON/ref argins for JSON syntax before invoking the machine.
    // Encode their strings too; ordinary string inputs retain literal CLI text.
    const type = schema[key]?.type
    const serialized =
      type === 'json' ||
      type === 'ref' ||
      (typeof value === 'object' && value !== null)
        ? JSON.stringify(value)
        : String(value)
    args.push(`--${key}=${serialized}`)
  }

  return args
}

module.exports = {
  executeJob,
  buildCommandArgs,
  createDiagnosticTail
}
