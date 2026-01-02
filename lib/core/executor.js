/**
 * core/executor.js
 *
 * Functions for executing jobs via child processes
 */

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

/**
 * Execute a job via `sails run`
 * @param {String} name - Job name
 * @param {Object} job - Job configuration
 * @param {Object} customInputs - Custom input values
 * @param {Object} context - Execution context with running map, config, etc
 * @returns {Promise} Resolves when job completes
 */
async function executeJob(name, job, customInputs = {}, context = {}) {
  const { running = new Map(), config = {} } = context

  // Check if job is already running (and overlapping is disabled)
  if (job.withoutOverlapping && running.has(name)) {
    if (global.sails) {
      sails.log.warn(`Job "${name}" is already running, skipping...`)
    }
    return { skipped: true, reason: 'already_running' }
  }

  // Don't run if paused
  if (job.paused) {
    if (global.sails) {
      sails.log.verbose(`Job "${name}" is paused, skipping...`)
    }
    return { skipped: true, reason: 'paused' }
  }

  if (global.sails) {
    sails.log.info(`Running job: ${name}`)
  }

  running.set(name, Date.now())

  // Merge inputs with priority: jobInputs < scriptInputs < customInputs
  const inputs = { ...job.inputs, ...job.scriptInputs, ...customInputs }

  // Emit job start event
  if (global.sails) {
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
      if (global.sails) {
        sails.log.error(error.message)
        sails.emit('quest:job:error', {
          name,
          inputs,
          error: { message: error.message },
          duration: 0,
          timestamp: new Date()
        })
      }
      return reject(error)
    }

    const child = spawn(sailsPath, args, {
      cwd,
      env,
      stdio: 'inherit'
    })

    child.on('exit', (code) => {
      const startTime = running.get(name)
      const duration = Date.now() - startTime
      running.delete(name)

      if (code === 0) {
        if (global.sails) {
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

        if (global.sails) {
          sails.log.error(error)

          // Emit error event
          sails.emit('quest:job:error', {
            name,
            inputs,
            error: {
              message: error.message,
              code
            },
            duration,
            timestamp: new Date()
          })
        }

        reject(error)
      }
    })

    child.on('error', (err) => {
      const startTime = running.get(name) || Date.now()
      const duration = Date.now() - startTime
      running.delete(name)

      if (global.sails) {
        sails.log.error(`Job "${name}" failed to start:`, err)

        // Emit error event
        sails.emit('quest:job:error', {
          name,
          inputs,
          error: {
            message: err.message,
            stack: err.stack
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
 * Build command arguments for sails run
 * @param {String} scriptName - Name of the script
 * @param {Object} inputs - Input values
 * @returns {Array} Command arguments
 */
function buildCommandArgs(scriptName, inputs = {}) {
  const args = ['run', scriptName]

  // Add inputs as command line args
  for (const [key, value] of Object.entries(inputs)) {
    args.push(`--${key}=${JSON.stringify(value)}`)
  }

  return args
}

module.exports = {
  executeJob,
  buildCommandArgs
}
