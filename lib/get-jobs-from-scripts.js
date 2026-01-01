/**
 * Module dependencies
 */
const _ = require('@sailshq/lodash')
const machineAsJob = require('./machine-as-job')

/**
 * getJobsFromScripts()
 *
 * Scan the scripts/ directory for Sails scripts that have job scheduling properties,
 * and convert them into Bree-compatible job definitions.
 *
 * Any script with scheduling properties (cron, interval, timeout, date) or the explicit
 * `job: true` flag will be treated as a Quest job. Other scripts are left alone and can
 * still be run manually via `sails run <script-name>`.
 *
 * This is the bridge between Sails scripts (which use the machine specification) and
 * Bree jobs (which need a name, schedule, and worker function).
 *
 * @param  {Dictionary} scripts
 *         A dictionary of script definitions loaded from the scripts/ directory
 *         (keyed by file path, e.g., { 'send-emails.js': { friendlyName: '...', fn: ... } })
 *
 * @param  {SailsApp} sails
 *         The Sails app instance
 *
 * @returns {Array}
 *          An array of Bree job configurations
 */
module.exports = function getJobsFromScripts(scripts, sails) {
  const jobs = []

  // These are the Bree-compatible scheduling properties that we look for
  // in a script definition to determine if it should be treated as a job.
  //
  // If a script has ANY of these properties, we'll register it as a Quest job.
  // Otherwise, it's just a regular script that can be run manually.
  const jobSchedulingProps = [
    'cron', // Standard cron expression (e.g., '0 * * * *')
    'interval', // Human-readable interval (e.g., '5m', '30s', '1h')
    'date', // Run once at a specific date/time
    'timeout', // Max execution time before termination
    'hasSeconds', // Whether cron expression includes seconds
    'cronValidate', // Custom cron validation options
    'closeWorkerAfterMs', // Close worker after this many ms
    'outputWorkerMetadata', // Output worker metadata
    'job' // Explicit flag to mark as job (even without schedule)
  ]

  _.each(scripts, function (script, scriptPath) {
    // Check if this script has any job scheduling properties
    const hasJobProps = _.some(jobSchedulingProps, (prop) =>
      script.hasOwnProperty(prop)
    )

    if (!hasJobProps) {
      // This is just a regular script, not a job
      return
    }

    // Extract job scheduling options from the script
    const schedulingOptions = _.pick(script, jobSchedulingProps)

    // Set job name from script friendlyName or file path
    const jobName = _.kebabCase(
      script.friendlyName || scriptPath.replace(/\.js$/, '')
    )

    sails.log.verbose(
      `Found scheduled script job: ${jobName}`,
      schedulingOptions
    )

    jobs.push({
      name: jobName,
      ...schedulingOptions,
      // Run in same process with full Sails context
      threaded: false,
      // Execute the Sails script
      path: async () => {
        try {
          sails.log.info(`Starting scheduled script: ${jobName}`)

          // Prepare script inputs using defaults
          const scriptInputs = {}
          if (script.inputs) {
            _.each(script.inputs, (inputDef, inputName) => {
              if (inputDef.defaultsTo !== undefined) {
                scriptInputs[inputName] = inputDef.defaultsTo
              }
            })
          }

          // Execute the script with full Sails context
          const result = await new Promise((resolve, reject) => {
            // Create done callback for non-async scripts
            const done = (err, result) => {
              if (err) {
                reject(err)
              } else {
                resolve(result)
              }
            }

            try {
              // Execute script function with Sails context as 'this'
              // Scripts can access: this.models, this.helpers, this.config, etc.
              const scriptResult = script.fn.call(sails, scriptInputs, done)

              // Handle async scripts (return promise)
              if (scriptResult && typeof scriptResult.then === 'function') {
                scriptResult.then(resolve).catch(reject)
              }
              // Handle sync scripts that don't use done callback
              else if (script.fn.length < 2) {
                resolve(scriptResult)
              }
              // Otherwise wait for done() callback
            } catch (error) {
              reject(error)
            }
          })

          sails.log.info(`Scheduled script '${jobName}' completed successfully`)
          return result
        } catch (error) {
          sails.log.error(`Scheduled script '${jobName}' failed:`, error)
          throw error
        }
      }
    })
  })

  return jobs
}
