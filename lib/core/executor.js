// @ts-check

/**
 * core/executor.js
 *
 * Functions for executing jobs via child processes
 */

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { getGlobalSails } = require('./global-sails')

const DEFAULT_DIAGNOSTIC_TAIL_BYTES = 64 * 1024

/** @typedef {import('../types').AnyRecord} AnyRecord */
/** @typedef {import('../types').QuestExecutableJob} QuestExecutableJob */
/** @typedef {import('../types').QuestExecutionResult} QuestExecutionResult */
/** @typedef {import('../types').QuestExecutorContext} QuestExecutorContext */

/**
 * Execute a job via `sails run`
 * @param {String} name - Job name
 * @param {QuestExecutableJob} job - Job configuration
 * @param {AnyRecord} [customInputs] - Custom input values
 * @param {QuestExecutorContext} [context] - Execution context with running map, config, etc
 * @returns {Promise<QuestExecutionResult>} Resolves when job completes
 */
async function executeJob(name, job, customInputs = {}, context = {}) {
  const { running = new Map(), config = {} } = context

  // Check if job is already running (and overlapping is disabled)
  if (job.withoutOverlapping && running.has(name)) {
    const sails = getGlobalSails()
    if (sails) {
      sails.log.warn(`Job "${name}" is already running, skipping...`)
    }
    return { skipped: true, reason: 'already_running' }
  }

  // Don't run if paused
  if (job.paused) {
    const sails = getGlobalSails()
    if (sails) {
      sails.log.verbose(`Job "${name}" is paused, skipping...`)
    }
    return { skipped: true, reason: 'paused' }
  }

  const sails = getGlobalSails()
  if (sails) {
    sails.log.info(`Running job: ${name}`)
  }

  running.set(name, Date.now())

  // Merge inputs with priority: jobInputs < scriptInputs < customInputs
  const inputs = {
    ...(job.inputs || {}),
    ...(job.scriptInputs || {}),
    ...customInputs
  }

  // Emit job start event
  if (sails) {
    sails.emit('quest:job:start', {
      name,
      inputs,
      timestamp: new Date()
    })
  }

  return new Promise((resolve, reject) => {
    // Build command arguments
    const args = buildCommandArgs(name, inputs)

    // Setup environment
    const env = { ...process.env }
    if (config.environment) {
      env.NODE_ENV = config.environment
    }

    const sailsPath = config.sailsPath || './node_modules/.bin/sails'
    const cwd = config.appPath || process.cwd()
    const scriptsDir = config.scriptsDir || 'scripts'

    // Validate script exists before attempting to run
    const scriptPath = path.resolve(cwd, scriptsDir, `${name}.js`)
    if (!fs.existsSync(scriptPath)) {
      running.delete(name)
      const error = new Error(
        `Job "${name}" not found. Please check that the script exists at ${scriptsDir}/${name}.js`
      )
      if (sails) {
        sails.log.error(error.message)
        sails.emit('quest:job:error', {
          name,
          inputs,
          error: { message: error.message, stack: error.stack },
          duration: 0,
          timestamp: new Date()
        })
      }
      return reject(error)
    }

    const diagnosticTail = createDiagnosticTail(config.diagnosticTailBytes)
    const child = spawn(sailsPath, args, {
      cwd,
      env,
      stdio: ['inherit', 'pipe', 'pipe']
    })

    teeChildOutput(
      child.stdout,
      context.stdout || process.stdout,
      diagnosticTail
    )
    teeChildOutput(
      child.stderr,
      context.stderr || process.stderr,
      diagnosticTail
    )

    let settled = false

    child.on('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      const startTime = /** @type {number} */ (running.get(name))
      const duration = Date.now() - startTime
      running.delete(name)

      if (code === 0) {
        if (sails) {
          sails.log.info(`Job "${name}" completed successfully`)

          // Emit success event
          sails.emit('quest:job:complete', {
            name,
            inputs,
            duration,
            timestamp: new Date()
          })
        }

        resolve({ success: true, duration })
      } else {
        const error = new Error(`Job "${name}" exited with code ${code}`)

        if (sails) {
          sails.log.error(error)

          // Emit error event
          sails.emit('quest:job:error', {
            name,
            inputs,
            error: {
              message: error.message,
              code,
              stack: error.stack,
              diagnostic: diagnosticTail.value()
            },
            duration,
            timestamp: new Date()
          })
        }

        reject(error)
      }
    })

    child.on('error', (err) => {
      if (settled) {
        return
      }
      settled = true
      const startTime = running.get(name) || Date.now()
      const duration = Date.now() - startTime
      running.delete(name)

      if (sails) {
        sails.log.error(`Job "${name}" failed to start:`, err)

        // Emit error event
        sails.emit('quest:job:error', {
          name,
          inputs,
          error: {
            message: err.message,
            stack: err.stack,
            diagnostic: diagnosticTail.value()
          },
          duration,
          timestamp: new Date()
        })
      }

      reject(err)
    })
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
      ? Math.floor(requestedMaxBytes)
      : DEFAULT_DIAGNOSTIC_TAIL_BYTES
  let buffer = Buffer.alloc(0)

  return {
    /** @param {Buffer|string} chunk */
    append(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      buffer = Buffer.concat([buffer, incoming])
      if (buffer.length > maxBytes) {
        buffer = buffer.subarray(buffer.length - maxBytes)
      }
    },
    value() {
      return buffer.toString('utf8').trim()
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
    destination.write(chunk)
  })
}

/**
 * Build command arguments for sails run
 * @param {String} scriptName - Name of the script
 * @param {AnyRecord} [inputs] - Input values
 * @returns {string[]} Command arguments
 */
function buildCommandArgs(scriptName, inputs = {}) {
  const args = ['run', scriptName]

  // Add inputs as command line args
  for (const [key, value] of Object.entries(inputs)) {
    // Only JSON.stringify objects and arrays (for type: 'json' or 'ref' inputs)
    // Primitives should be passed directly for whelk/rttc.parseHuman() to handle
    const serialized =
      typeof value === 'object' && value !== null
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
