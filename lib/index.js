// @ts-check

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
const resident = require('./core/runtime')
const { isExecutionChild } = require('./core/execution-child')

/** @typedef {import('./types').AnyRecord} AnyRecord */
/** @typedef {import('./types').QuestApi} QuestApi */
/** @typedef {import('./types').QuestConfig} QuestConfig */
/** @typedef {import('./types').QuestContext} QuestContext */
/** @typedef {import('./types').QuestExecutableJob} QuestExecutableJob */
/** @typedef {import('./types').QuestJobsMap} QuestJobsMap */
/** @typedef {import('./types').QuestNamedJobDefinition} QuestNamedJobDefinition */
/** @typedef {import('./types').QuestRunningMap} QuestRunningMap */
/** @typedef {import('./types').QuestSailsApp} QuestSailsApp */
/** @typedef {import('./types').QuestSailsHook} QuestSailsHook */
/** @typedef {import('./types').QuestTimersMap} QuestTimersMap */

/**
 * Sails hook factory.
 *
 * @param {QuestSailsApp} sails
 * @returns {QuestSailsHook}
 */
function defineQuestHook(sails) {
  /** @type {QuestJobsMap} */
  const jobs = new Map()
  /** @type {QuestTimersMap} */
  const timers = new Map()
  /** @type {QuestRunningMap} */
  const running = new Map()

  // Create context object that will be passed to modules
  /** @type {QuestContext} */
  const context = {
    jobs,
    timers,
    running,
    sails,
    runtime: resident.createRuntime(),
    dueTimes: new Map(),
    scheduleStates: new Map(),
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

        // Maximum child output retained on failure (live output remains unbounded)
        diagnosticTailBytes: 64 * 1024,

        resultBytes: 64 * 1024,
        inputBytes: 64 * 1024,

        // Jobs defined in config
        jobs: []
      }
    },

    initialize: async function () {
      sails.log.info('Initializing Quest job scheduler')

      // Register cleanup before awaiting dependencies so failed lift also stops timers.
      sails.on('lower', async () => {
        sails.log.info('Stopping Quest jobs...')
        await jobControl.stopJobs(null, context)
      })

      const initializeQuest = async () => {
        // The owned CLI child needs the app's hooks/context, but must not start
        // another copy of its resident schedules, even if source config enables it.
        if (isExecutionChild()) sails.config.quest.autoStart = false
        const questConfig = {
          ...sails.config.quest,
          appPath:
            sails.config.quest.appPath || sails.config.appPath || process.cwd()
        }

        // Set up context with config
        context.config = questConfig
        context.getNextRunTime = (job) =>
          scheduler.getNextRunTime(job, questConfig, (assessment) => {
            context.scheduleStates.set(job.name, {
              ...context.scheduleStates.get(job.name),
              ...assessment
            })
          })
        context.scheduleJob = (name) => jobControl.scheduleJob(name, context)
        context.executeJob = (name, customInputs, trigger = 'manual') => {
          const job = jobs.get(name)
          if (!job) {
            // Try to run as a regular script without quest config
            /** @type {QuestExecutableJob} */
            const minimalJob = {
              name,
              withoutOverlapping: false,
              inputs: {}
            }
            return executor.executeJob(name, minimalJob, customInputs, {
              ...context,
              trigger
            })
          }
          return executor.executeJob(name, job, customInputs, {
            ...context,
            trigger
          })
        }

        // Load jobs from scripts and config
        await loader.loadJobs(questConfig, jobs)

        // Start all jobs if autoStart is enabled
        if (questConfig.autoStart) {
          await jobControl.startJobs(null, context)
        }

        // Expose the Quest API
        /** @type {QuestApi} */
        const questApi = {
          // Core job control
          start: (jobNames) => jobControl.startJobs(jobNames, context),
          stop: (jobNames) => jobControl.stopJobs(jobNames, context),
          run: (jobNames, inputs) =>
            jobControl.runJobs(jobNames, inputs, context),
          add: (jobDefs) => {
            const defs = Array.isArray(jobDefs) ? jobDefs : [jobDefs]
            /** @type {string[]} */
            const added = []
            for (const def of defs) {
              /** @type {QuestNamedJobDefinition} */
              const job = typeof def === 'string' ? { name: def } : def
              loader.addJobDefinition(job, jobs, context.config || {})
              context.scheduleStates.delete(job.name)
              added.push(job.name)
              if (context.config?.autoStart) {
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
                context.dueTimes.delete(name)
                context.scheduleStates.delete(name)
                removed.push(name)
              }
            }
            return removed
          },

          getRuntime: () => resident.runtimeInfo(context),
          metadata: (name) => resident.metadata(context, name),

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

        sails.quest = questApi
        sails.log.info(`Quest started with ${jobs.size} scheduled job(s)`)
      }

      // Disabled/excluded hooks never emit a loaded event. Database-free apps
      // initialize directly; apps with ORM retain its existing readiness order.
      if (sails.hooks.orm) {
        await new Promise((resolve, reject) => {
          sails.after('hook:orm:loaded', () => {
            initializeQuest().then(resolve, reject)
          })
        })
      } else {
        await initializeQuest()
      }
    }
  }
}

module.exports = defineQuestHook
