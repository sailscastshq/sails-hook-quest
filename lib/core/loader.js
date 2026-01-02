/**
 * core/loader.js
 *
 * Functions for loading and managing job definitions
 */

const path = require('path')
const includeAll = require('include-all')

/**
 * Extract default values from a script's inputs schema
 * @param {Object} inputs - Script's inputs definition (Sails machine format)
 * @returns {Object} Object with input names and their defaultsTo values
 */
function extractScriptInputDefaults(inputs) {
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
 * @param {Object} config - Quest configuration
 * @param {Map} jobs - Jobs map to populate
 * @returns {Promise<Map>} Populated jobs map
 */
async function loadJobs(config, jobs = new Map()) {
  // First, load scripts from the scripts directory
  const scriptsDir = config.scriptsDir || 'scripts'
  const appPath = config.appPath || process.cwd()
  const fullPath = path.resolve(appPath, scriptsDir)

  let scripts = {}

  try {
    scripts = includeAll({
      dirname: fullPath,
      filter: /(.+)\.js$/,
      excludeDirs: /^\.(git|svn)$/,
      flatten: true
    })
  } catch (e) {
    if (global.sails) {
      sails.log.verbose('No scripts directory found, skipping script jobs')
    }
  }

  // First, add jobs from config (provides base inputs)
  if (Array.isArray(config.jobs)) {
    const configJobNames = new Set()

    for (const jobDef of config.jobs) {
      // Handle string shorthand (just job name)
      const job = typeof jobDef === 'string' ? { name: jobDef } : jobDef

      // Check for duplicate job names in config
      if (configJobNames.has(job.name)) {
        throw new Error(
          `Duplicate job name "${job.name}" in config/quest.js. Each job must have a unique name.`
        )
      }
      configJobNames.add(job.name)

      // Try to get script inputs if the script exists
      const scriptDef = scripts[job.name]
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
    const jobDef = {
      name: jobName,
      friendlyName: scriptDef.friendlyName,
      description: scriptDef.description,
      // Preserve config's withoutOverlapping if script doesn't specify
      withoutOverlapping: existingJob?.withoutOverlapping,
      inputs: { ...existingJob?.inputs, ...questConfig.inputs },
      ...questConfig,
      scriptInputs
    }

    addJobDefinition(jobDef, jobs, config)
  }

  return jobs
}

/**
 * Add a job definition to the jobs Map
 * @param {Object} jobDef - Job definition
 * @param {Map} jobs - Jobs map
 * @param {Object} config - Quest configuration
 * @returns {Object} Normalized job
 */
function addJobDefinition(jobDef, jobs = new Map(), config = {}) {
  const name = jobDef.name
  if (!name) {
    if (global.sails) {
      sails.log.warn('Job definition missing name, skipping:', jobDef)
    }
    return null
  }

  // Parse and normalize the job definition
  const job = {
    name,
    friendlyName: jobDef.friendlyName || name,
    description: jobDef.description,

    // Scheduling options
    interval: jobDef.interval,
    timeout: jobDef.timeout,
    cron: jobDef.cron,
    cronValidate: jobDef.cronValidate,
    date: jobDef.date,

    // Input data to pass to the script
    inputs: jobDef.inputs || {},
    scriptInputs: jobDef.scriptInputs || {},

    // Control options
    paused: false,
    withoutOverlapping:
      jobDef.withoutOverlapping ?? config.withoutOverlapping ?? true
  }

  jobs.set(name, job)

  if (global.sails) {
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
 * @param {Map} jobs - Jobs map
 * @param {Map} timers - Timers map
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

  if (existed && global.sails) {
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
