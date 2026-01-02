/**
 * sails-hook-quest
 *
 * Elegant job scheduling for Sails.js with powerful scheduling syntax
 * Execute scripts via `sails run` to maintain full Sails context
 */

const scheduler = require('./core/scheduler')
const executor = require('./core/executor')
const loader = require('./core/loader')
const jobControl = require('./core/job-control')

module.exports = function defineQuestHook(sails) {
  const jobs = new Map()
  const timers = new Map()
  const running = new Map()

  // Create context object that will be passed to modules
  const context = {
    jobs,
    timers,
    running,
    config: null, // Will be set after sails.config is available
    scheduleJob: null, // Will be set after function is defined
    executeJob: null, // Will be set after function is defined
    getNextRunTime: null // Will be set after config is available
  }

  return {
    defaults: {
      quest: {
        // Whether to start jobs automatically
        autoStart: true,

        // Timezone for cron expressions
        timezone: 'UTC',

        // Prevent overlapping runs by default
        withoutOverlapping: true,

        // Path to sails executable
        sailsPath: './node_modules/.bin/sails',

        // Environment to run jobs in (e.g., 'console' for minimal Sails lift)
        environment: 'console',

        // Directory containing job scripts
        scriptsDir: 'scripts',

        // Jobs defined in config
        jobs: []
      }
    },

    initialize: async function () {
      sails.log.info('Initializing Quest job scheduler')

      sails.after('hook:orm:loaded', async () => {
        // Set up context with config
        context.config = sails.config.quest
        context.getNextRunTime = (job) =>
          scheduler.getNextRunTime(job, sails.config.quest)
        context.scheduleJob = (name) => jobControl.scheduleJob(name, context)
        context.executeJob = (name, customInputs) => {
          const job = jobs.get(name)
          if (!job) {
            // Try to run as a regular script without quest config
            const minimalJob = {
              name,
              withoutOverlapping: false,
              inputs: {}
            }
            return executor.executeJob(name, minimalJob, customInputs, context)
          }
          return executor.executeJob(name, job, customInputs, context)
        }

        // Load jobs from scripts and config
        await loader.loadJobs(sails.config.quest, jobs)

        // Start all jobs if autoStart is enabled
        if (sails.config.quest.autoStart) {
          await jobControl.startJobs(null, context)
        }

        // Expose the Quest API
        sails.quest = {
          // Core job control
          start: (jobNames) => jobControl.startJobs(jobNames, context),
          stop: (jobNames) => jobControl.stopJobs(jobNames, context),
          run: (jobNames, inputs) =>
            jobControl.runJobs(jobNames, inputs, context),
          add: (jobDefs) => {
            const defs = Array.isArray(jobDefs) ? jobDefs : [jobDefs]
            const added = []
            for (const def of defs) {
              const job = typeof def === 'string' ? { name: def } : def
              loader.addJobDefinition(job, jobs, context.config)
              added.push(job.name)
              if (context.config.autoStart) {
                jobControl.scheduleJob(job.name, context)
              }
            }
            return added
          },
          remove: (jobNames) => {
            const names = Array.isArray(jobNames) ? jobNames : [jobNames]
            const removed = []
            for (const name of names) {
              if (loader.removeJob(name, jobs, timers)) {
                removed.push(name)
              }
            }
            return removed
          },

          // Job information
          jobs: Array.from(jobs.values()),

          // Additional helpers
          list: () => Array.from(jobs.values()),
          get: (name) => jobs.get(name),
          isRunning: (name) => running.has(name),

          // Pause/resume
          pause: (name) => jobControl.pauseJob(name, jobs),
          resume: (name) => jobControl.resumeJob(name, jobs)
        }

        sails.log.info(`Quest started with ${jobs.size} scheduled job(s)`)
      })

      // Graceful shutdown
      sails.on('lower', async () => {
        sails.log.info('Stopping Quest jobs...')
        await jobControl.stopJobs(null, context)
      })
    }
  }
}
