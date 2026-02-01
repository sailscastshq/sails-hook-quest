/**
 * core/job-control.js
 *
 * Functions for controlling job lifecycle (start, stop, pause, resume)
 */

// setTimeout uses a 32-bit signed integer internally.
// Delays larger than this overflow and fire immediately (~1ms), causing infinite loops.
const MAX_SAFE_TIMEOUT = 2_147_483_647 // 2^31 - 1, ~24.8 days

/**
 * Schedule a job to run at its next scheduled time
 * @param {String} name - Job name
 * @param {Object} context - Context with jobs, timers maps and helper functions
 */
function scheduleJob(name, context = {}) {
  const {
    jobs = new Map(),
    timers = new Map(),
    getNextRunTime,
    executeJob
  } = context

  const job = jobs.get(name)
  if (!job) {
    if (global.sails) {
      sails.log.warn(`Job "${name}" not found in jobs Map`)
    }
    return
  }

  // Clear any existing timer
  stopJob(name, { timers })

  // Get the next run time
  const nextRun = getNextRunTime(job)
  if (!nextRun) {
    if (global.sails) {
      sails.log.warn(
        `Job "${name}" has no valid schedule (interval: ${job.interval}, cron: ${job.cron}, timeout: ${job.timeout})`
      )
    }
    return
  }

  const delay = nextRun.getTime() - Date.now()

  // If delay is negative (past time), run immediately
  if (delay <= 0) {
    executeJob(name).catch((err) => {
      if (global.sails) {
        sails.log.error(`Error running job "${name}":`, err)
      }
    })

    // If it's a recurring job, schedule the next run
    if (job.interval || job.cron) {
      scheduleJob(name, context)
    }
    return
  }

  // If delay exceeds the 32-bit setTimeout max, set an intermediate timer
  // that rechecks when we're closer to the target time
  if (delay > MAX_SAFE_TIMEOUT) {
    const timer = setTimeout(() => {
      scheduleJob(name, context)
    }, MAX_SAFE_TIMEOUT)

    timers.set(name, timer)

    if (global.sails) {
      sails.log.verbose(
        `Job "${name}" scheduled for ${nextRun.toISOString()} (delay exceeds 24.8d, re-checking later)`
      )
    }
    return
  }

  // Set timer for the next execution
  const timer = setTimeout(() => {
    executeJob(name).catch((err) => {
      if (global.sails) {
        sails.log.error(`Error running job "${name}":`, err)
      }
    })

    // If it's a recurring job, schedule the next run
    if (job.interval || job.cron) {
      scheduleJob(name, context)
    }
  }, delay)

  timers.set(name, timer)

  if (global.sails) {
    sails.log.verbose(`Job "${name}" scheduled for ${nextRun.toISOString()}`)
  }
}

/**
 * Stop a single job
 * @param {String} name - Job name
 * @param {Object} context - Context with timers map
 */
function stopJob(name, context = {}) {
  const { timers = new Map() } = context

  const timer = timers.get(name)
  if (timer) {
    clearTimeout(timer)
    clearInterval(timer)
    timers.delete(name)
    if (global.sails) {
      sails.log.verbose(`Job "${name}" stopped`)
    }
  }
}

/**
 * Start scheduling jobs
 * @param {String|Array} jobNames - Job names to start (optional)
 * @param {Object} context - Context with jobs map and scheduleJob function
 */
async function startJobs(jobNames, context = {}) {
  const { jobs = new Map(), scheduleJob } = context

  const names = !jobNames
    ? Array.from(jobs.keys())
    : Array.isArray(jobNames)
      ? jobNames
      : [jobNames]

  for (const name of names) {
    scheduleJob(name)
  }
}

/**
 * Stop scheduling jobs
 * @param {String|Array} jobNames - Job names to stop (optional)
 * @param {Object} context - Context with jobs and timers maps
 */
function stopJobs(jobNames, context = {}) {
  const { jobs = new Map(), timers = new Map() } = context

  const names = !jobNames
    ? Array.from(jobs.keys())
    : Array.isArray(jobNames)
      ? jobNames
      : [jobNames]

  for (const name of names) {
    stopJob(name, { timers })
  }
}

/**
 * Run jobs immediately
 * @param {String|Array} jobNames - Job names to run
 * @param {Object} inputs - Custom inputs
 * @param {Object} context - Context with executeJob function
 */
async function runJobs(jobNames, inputs, context = {}) {
  const { jobs = new Map(), executeJob } = context

  const names = !jobNames
    ? Array.from(jobs.keys())
    : Array.isArray(jobNames)
      ? jobNames
      : [jobNames]

  const promises = names.map((name) => executeJob(name, inputs))
  return Promise.all(promises)
}

/**
 * Pause a job
 * @param {String} name - Job name
 * @param {Map} jobs - Jobs map
 */
function pauseJob(name, jobs = new Map()) {
  const job = jobs.get(name)
  if (job) {
    job.paused = true
    return true
  }
  return false
}

/**
 * Resume a job
 * @param {String} name - Job name
 * @param {Map} jobs - Jobs map
 */
function resumeJob(name, jobs = new Map()) {
  const job = jobs.get(name)
  if (job) {
    job.paused = false
    return true
  }
  return false
}

module.exports = {
  scheduleJob,
  stopJob,
  startJobs,
  stopJobs,
  runJobs,
  pauseJob,
  resumeJob
}
