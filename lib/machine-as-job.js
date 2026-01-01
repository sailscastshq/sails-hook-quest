/**
 * Module dependencies
 */
const Machine = require('machine')

/**
 * machineAsJob()
 *
 * Build a "wet" machine that can be executed as a background job.
 *
 * This is like `machine-as-action`, but instead of running from an HTTP request,
 * it runs as a scheduled or manually-triggered background job with full Sails context.
 *
 * The resulting function can be:
 * - Executed on a schedule (via cron/interval)
 * - Triggered manually (via sails.quest.run())
 * - Run from the command line (via sails run)
 *
 * Jobs get access to the full Sails context:
 * - Global models (User.find(), Product.create(), etc.)
 * - sails.helpers.* (all your custom helpers)
 * - sails.config.* (your app configuration)
 * - Database connections, Redis, etc.
 *
 * Example:
 * ```
 * module.exports = {
 *   friendlyName: 'Send welcome emails',
 *   cron: '0 * * * *',  // Run hourly
 *   inputs: { testMode: { type: 'boolean', defaultsTo: false } },
 *   fn: async function(inputs, exits) {
 *     const newUsers = await User.find({ welcomeEmailSent: false })
 *     // ... send emails ...
 *     return exits.success({ sent: newUsers.length })
 *   }
 * }
 * ```
 *
 * @param  {Dictionary} machineDef
 *         The machine definition (with optional scheduling properties)
 *
 * @param  {SailsApp} sails
 *         The Sails app instance (for context, logging, and events)
 *
 * @returns {Function}
 *          An async function that executes the job and handles its lifecycle
 */
module.exports = function machineAsJob(machineDef, sails) {
  // Build the machine configuration from the definition.
  // We extract only the machine-relevant properties and leave
  // job-specific properties (like cron, interval, etc.) for
  // the scheduler to handle.
  const jobConfig = {
    friendlyName: machineDef.friendlyName,
    description: machineDef.description,
    inputs: machineDef.inputs || {},
    exits: machineDef.exits || {
      success: { description: 'Job completed successfully' },
      error: { description: 'Job failed' }
    },
    fn: machineDef.fn
  }

  // Build a "wet" machine using the machine runner.
  // This gives us input validation, exit handling, and all the
  // other niceties that come with the machine specification.
  const wetMachine = Machine.buildWithCustomUsage({
    arginStyle: 'named',
    execStyle: 'deferred',
    implementationSniffingTactic: sails?.config?.implementationSniffingTactic,
    def: jobConfig
  })

  // Return an async function that wraps the machine execution
  // with job-specific concerns like logging, timing, and events.
  return async function executeJob(jobInputs = {}) {
    const startTime = Date.now()
    const jobName = machineDef.friendlyName || 'unnamed-job'

    // Log the start of the job.
    // This helps developers track what's happening in their background jobs.
    sails.log.info(`[Quest Job] Starting: ${jobName}`)

    // Emit a 'started' event.
    // This allows other parts of the application to react to job starts
    // (e.g., updating a dashboard, logging to a database, etc.)
    sails.emit('quest:job:started', {
      jobName,
      friendlyName: machineDef.friendlyName,
      timestamp: new Date()
    })

    try {
      // Build the inputs object by merging explicit inputs with defaults.
      // This mimics how machine-as-action handles request parameters.
      const inputsWithDefaults = {}

      if (machineDef.inputs) {
        Object.keys(machineDef.inputs).forEach((inputName) => {
          const inputDef = machineDef.inputs[inputName]
          if (jobInputs.hasOwnProperty(inputName)) {
            inputsWithDefaults[inputName] = jobInputs[inputName]
          } else if (inputDef.defaultsTo !== undefined) {
            inputsWithDefaults[inputName] = inputDef.defaultsTo
          }
        })
      }

      // Attach the inputs to the machine instance.
      const machineInstance = wetMachine.with(inputsWithDefaults)

      // Execute the machine and handle its exits.
      // We wrap this in a Promise so we can await the result and
      // capture which exit was triggered (success, error, or custom).
      const result = await new Promise((resolve, reject) => {
        const exitHandlers = {
          success: (output) => {
            resolve({ exit: 'success', output })
          },
          error: (err) => {
            reject(err)
          }
        }

        // Build handlers for any custom exits defined in the machine.
        // For example, a job might have 'partialFailure' or 'rateLimitHit' exits.
        Object.keys(machineDef.exits || {}).forEach((exitName) => {
          if (exitName !== 'success' && exitName !== 'error') {
            exitHandlers[exitName] = (output) => {
              resolve({ exit: exitName, output })
            }
          }
        })

        // Execute the machine with our exit handlers.
        machineInstance.exec(exitHandlers)
      })

      // Calculate how long the job took to run.
      const duration = Date.now() - startTime

      // Log successful completion.
      sails.log.info(
        `[Quest Job] Completed: ${jobName} (${duration}ms) via ${result.exit} exit`
      )

      // Emit a 'complete' event.
      // This is super useful for:
      // - Logging job results to a database
      // - Triggering dependent jobs
      // - Sending notifications
      // - Tracking metrics
      sails.emit('quest:job:complete', {
        jobName,
        friendlyName: machineDef.friendlyName,
        exit: result.exit,
        output: result.output,
        duration,
        timestamp: new Date()
      })

      // If the job definition includes an onSuccess callback, call it.
      // This allows jobs to define custom post-completion logic.
      if (machineDef.onSuccess && result.exit === 'success') {
        await machineDef.onSuccess.call(sails, result.output)
      }

      return result
    } catch (error) {
      // Something went wrong. Let's handle it gracefully.
      const duration = Date.now() - startTime

      // Log the error with context.
      sails.log.error(`[Quest Job] Failed: ${jobName} (${duration}ms)`, error)

      // Emit an 'error' event.
      // This allows the application to:
      // - Send alerts (Slack, email, PagerDuty)
      // - Log errors to a tracking service (Sentry, Rollbar)
      // - Implement retry logic
      // - Update job status in a database
      sails.emit('quest:job:error', {
        jobName,
        friendlyName: machineDef.friendlyName,
        error,
        duration,
        timestamp: new Date()
      })

      // If the job definition includes an onError callback, call it.
      // This allows jobs to define custom error handling logic.
      if (machineDef.onError) {
        await machineDef.onError.call(sails, error)
      }

      // Re-throw the error so Bree or the manual caller knows it failed.
      throw error
    }
  }
}
