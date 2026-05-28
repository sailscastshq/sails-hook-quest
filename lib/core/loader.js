// @ts-check

/**
 * core/loader.js
 *
 * Functions for loading and managing job definitions
 */

const path = require('path')
const includeAll = require('include-all')
const { getGlobalSails } = require('./global-sails')

/** @typedef {import('../types').AnyRecord} AnyRecord */
/** @typedef {import('../types').QuestConfig} QuestConfig */
/** @typedef {import('../types').QuestJob} QuestJob */
/** @typedef {import('../types').QuestJobDefinition} QuestJobDefinition */
/** @typedef {import('../types').QuestJobsMap} QuestJobsMap */
/** @typedef {import('../types').QuestMachineInputs} QuestMachineInputs */
/** @typedef {import('../types').QuestScriptDefinition} QuestScriptDefinition */
/** @typedef {import('../types').QuestTimersMap} QuestTimersMap */

/**
 * Extract default values from a script's inputs schema
 * @param {QuestMachineInputs | null | undefined} inputs - Script's inputs definition (Sails machine format)
 * @returns {AnyRecord} Object with input names and their defaultsTo values
 */
function extractScriptInputDefaults(inputs) {
  /** @type {AnyRecord} */
  const defaults = {}
  if (!inputs || typeof inputs !== 'object') return defaults

  for (const [key, def] of Object.entries(inputs)) {
    if (def && def.defaultsTo !== undefined) {
      defaults[key] = def.defaultsTo
    }
  }
  return defaults
}

/**
 * Load jobs from scripts directory and config
 * @param {QuestConfig} config - Quest configuration
 * @param {QuestJobsMap} [jobs] - Jobs map to populate
 * @returns {Promise<QuestJobsMap>} Populated jobs map
 */
async function loadJobs(config, jobs = new Map()) {
  // First, load scripts from the scripts directory
  const scriptsDir = config.scriptsDir || 'scripts'
  const appPath = config.appPath || process.cwd()
  const fullPath = path.resolve(appPath, scriptsDir)

  /** @type {Record<string, QuestScriptDefinition>} */
  let scripts = {}

  try {
    scripts = /** @type {Record<string, QuestScriptDefinition>} */ (
      includeAll({
        dirname: fullPath,
        filter: /(.+)\.js$/,
        excludeDirs: /^\.(git|svn)$/,
        flatten: true
      })
    )
  } catch (e) {
    const sails = getGlobalSails()
    if (sails) {
      sails.log.verbose('No scripts directory found, skipping script jobs')
    }
  }

  // First, add jobs from config (provides base inputs)
  if (Array.isArray(config.jobs)) {
    const configJobNames = new Set()

    for (const jobDef of config.jobs) {
      // Handle string shorthand (just job name)
      /** @type {QuestJobDefinition} */
      const job = typeof jobDef === 'string' ? { name: jobDef } : jobDef
      const jobName = job.name

      // Check for duplicate job names in config
      if (jobName && configJobNames.has(jobName)) {
        throw new Error(
          `Duplicate job name "${jobName}" in config/quest.js. Each job must have a unique name.`
        )
      }
      if (jobName) {
        configJobNames.add(jobName)
      }

      // Try to get script inputs if the script exists
      const scriptDef = jobName ? scripts[jobName] : undefined
      if (scriptDef && !job.scriptInputs) {
        job.scriptInputs = extractScriptInputDefaults(scriptDef.inputs)
      }

      addJobDefinition(job, jobs, config)
    }
  }

  // Then process scripts with quest config (script scheduling takes priority)
  for (const [scriptFile, scriptDef] of Object.entries(scripts)) {
    if (!scriptDef.quest) continue

    const scriptName = scriptFile.replace(/\.js$/, '')
    const questConfig = scriptDef.quest
    const jobName = questConfig.name || scriptName

    // Extract default values from script's inputs schema
    const scriptInputs = extractScriptInputDefaults(scriptDef.inputs)

    // Check if job was already defined in config
    const existingJob = jobs.get(jobName)

    // Merge: config as base, script quest config takes priority
    /** @type {QuestJobDefinition} */
    const jobDef = {
      name: jobName,
      friendlyName: scriptDef.friendlyName,
      description: scriptDef.description,
      // Preserve config's withoutOverlapping if script doesn't specify
      withoutOverlapping: existingJob?.withoutOverlapping,
      inputs: { ...(existingJob?.inputs || {}), ...(questConfig.inputs || {}) },
      ...questConfig,
      scriptInputs
    }

    addJobDefinition(jobDef, jobs, config)
  }

  return jobs
}

/**
 * Add a job definition to the jobs Map
 * @param {QuestJobDefinition} jobDef - Job definition
 * @param {QuestJobsMap} [jobs] - Jobs map
 * @param {QuestConfig} [config] - Quest configuration
 * @returns {QuestJob | null} Normalized job
 */
function addJobDefinition(jobDef, jobs = new Map(), config = {}) {
  const name = jobDef.name
  if (!name) {
    const sails = getGlobalSails()
    if (sails) {
      sails.log.warn('Job definition missing name, skipping:', jobDef)
    }
    return null
  }

  // Parse and normalize the job definition
  /** @type {QuestJob} */
  const job = {
    name,
    friendlyName: jobDef.friendlyName || name,
    description: jobDef.description,

    // Scheduling options
    interval: jobDef.interval,
    timeout: jobDef.timeout,
    cron: jobDef.cron,
    cronOptions: jobDef.cronOptions,
    date: jobDef.date,
    timezone: jobDef.timezone,

    // Input data to pass to the script
    inputs: jobDef.inputs || {},
    scriptInputs: jobDef.scriptInputs || {},

    // Control options
    paused: false,
    withoutOverlapping:
      jobDef.withoutOverlapping ?? config.withoutOverlapping ?? true
  }

  jobs.set(name, job)

  const sails = getGlobalSails()
  if (sails) {
    const schedule = {}
    if (job.interval !== undefined) schedule.interval = job.interval
    if (job.cron !== undefined) schedule.cron = job.cron
    if (job.timeout !== undefined) schedule.timeout = job.timeout
    sails.log.verbose(`Registered job: ${name}`, schedule)
  }

  return job
}

/**
 * Remove a job from the jobs map
 * @param {String} name - Job name
 * @param {QuestJobsMap} [jobs] - Jobs map
 * @param {QuestTimersMap} [timers] - Timers map
 * @returns {Boolean} Success
 */
function removeJob(name, jobs = new Map(), timers = new Map()) {
  // Clear any associated timer
  if (timers.has(name)) {
    const timer = timers.get(name)
    clearTimeout(timer)
    clearInterval(timer)
    timers.delete(name)
  }

  // Remove from jobs map
  const existed = jobs.delete(name)

  const sails = getGlobalSails()
  if (existed && sails) {
    sails.log.verbose(`Job "${name}" removed`)
  }

  return existed
}

module.exports = {
  loadJobs,
  addJobDefinition,
  removeJob,
  extractScriptInputDefaults
}
