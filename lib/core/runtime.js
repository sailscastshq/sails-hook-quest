// @ts-check
const { randomUUID } = require('node:crypto')
const { encodeResult } = require('./result')
const { effectiveTimezone } = require('./scheduler')

function createRuntime() {
  return {
    runtimeId: randomUUID(),
    sequence: 0,
    active: new Map(),
    controls: new Map()
  }
}

/** @param {import('../types').QuestContext} context */
function runtimeInfo(context) {
  return {
    contractVersion: 1,
    runtimeId: context.runtime.runtimeId,
    scope: 'process',
    capabilities: {
      inputMetadata: true,
      runIdentity: true,
      businessResults: true,
      residentState: true,
      childSchedulerSuppression: true,
      triggerProvenance: true,
      terminalExitCode: true,
      terminalSignal: true,
      scheduleDiagnostics: true,
      cancellation:
        context.config?.runtimeControls === true &&
        process.platform === 'linux',
      liveLogs:
        context.config?.runtimeControls === true &&
        process.platform === 'linux',
      durableHistory: false
    }
  }
}

const fields = [
  'type',
  'description',
  'friendlyName',
  'required',
  'allowNull',
  'isIn',
  'min',
  'max',
  'minLength',
  'maxLength',
  'isEmail',
  'isURL',
  'isInteger',
  'regex',
  'example'
]
/** @param {import('../types').QuestMachineInputs} [schema] */
function inputMetadata(schema = {}) {
  const result = Object.create(null)
  for (const [name, def] of Object.entries(schema)) {
    if (!def || typeof def !== 'object') continue
    const field = Object.create(null)
    field.sensitive = Boolean(
      def.protect ||
        def.secret ||
        def.sensitive ||
        /password|secret|token|credential/i.test(name)
    )
    field.customValidation = typeof def.custom === 'function'
    for (const key of fields) {
      if (field.sensitive && key === 'example') continue
      if (Object.prototype.hasOwnProperty.call(def, key)) {
        const encoded = encodeResult(def[key], 4096)
        if (encoded.status === 'available') field[key] = encoded.value
      }
    }
    if (
      !field.sensitive &&
      Object.prototype.hasOwnProperty.call(def, 'defaultsTo')
    ) {
      const encoded = encodeResult(def.defaultsTo, 4096)
      if (encoded.status === 'available') field.defaultsTo = encoded.value
    }
    result[name] = field
  }
  return result
}

/** Describe the raw effective scheduled values; validation is still Sails' authority.
 * @param {import('../types').QuestJob} job
 */
function scheduledInputs(job) {
  const schema = job.inputSchema || {}
  const safeSchema = inputMetadata(schema)
  const configured = job.inputs || {}
  const scriptInputs = job.scriptInputs || {}
  const names = new Set([
    ...Object.keys(schema),
    ...Object.keys(configured),
    ...Object.keys(scriptInputs)
  ])
  const values = Object.create(null)
  const fields = Object.create(null)
  let remaining = 64 * 1024
  for (const name of names) {
    const own = (object) => Object.prototype.hasOwnProperty.call(object, name)
    const source = own(scriptInputs)
      ? 'script_input'
      : own(configured)
        ? 'job_input'
        : schema[name]?.defaultsTo !== undefined
          ? 'schema_default'
          : 'omitted'
    const value =
      source === 'script_input'
        ? scriptInputs[name]
        : source === 'job_input'
          ? configured[name]
          : source === 'schema_default'
            ? schema[name].defaultsTo
            : undefined
    const sensitive =
      safeSchema[name]?.sensitive ||
      /password|secret|token|credential/i.test(name)
    /** @type {import('../types').AnyRecord} */
    const field = {
      source,
      sensitive: Boolean(sensitive),
      available: false,
      missingRequired: Boolean(schema[name]?.required && value === undefined)
    }
    if (value !== undefined && !sensitive) {
      const encoded = encodeResult(
        value,
        Math.max(1, Math.min(4096, remaining))
      )
      if (
        encoded.status === 'available' &&
        Buffer.byteLength(encoded.json) <= remaining
      ) {
        values[name] = encoded.value
        field.available = true
        remaining -= Buffer.byteLength(encoded.json)
      } else
        field.reason =
          encoded.status === 'available' ? 'metadata_limit' : encoded.status
    } else if (sensitive) field.reason = 'sensitive'
    fields[name] = field
  }
  return { values, fields, validation: 'not_checked', limitBytes: 64 * 1024 }
}

/** Mirror parser precedence; unused lower-priority fields do not change restart semantics. */
function restartSemantics(job) {
  let timing = 'none'
  let oneShot = false
  if (job.cron) timing = 'wall_clock'
  else if (job.interval !== undefined && job.interval !== false)
    timing =
      typeof job.interval === 'string' && /at|on the/.test(job.interval)
        ? 'wall_clock'
        : 'relative_to_registration'
  else if (job.timeout !== undefined && job.timeout !== false) {
    timing =
      typeof job.timeout === 'string' && job.timeout.startsWith('at ')
        ? 'wall_clock'
        : 'relative_to_registration'
    oneShot = true
  } else if (job.date !== undefined && job.date !== false) {
    timing = 'wall_clock'
    oneShot = true
  }
  return {
    persistence: 'memory_only',
    timing,
    oneShot,
    missedRuns: 'not_replayed'
  }
}

/** @param {import('../types').QuestContext} context @param {string} [name] */
function metadata(context, name) {
  const describe = (job) => {
    const schedule = {}
    for (const key of [
      'interval',
      'cron',
      'cronOptions',
      'timeout',
      'date',
      'timezone'
    ]) {
      if (job[key] !== undefined) {
        const encoded = encodeResult(
          job[key] instanceof Date
            ? Number.isFinite(job[key].getTime())
              ? job[key].toISOString()
              : null
            : job[key],
          4096
        )
        if (encoded.status === 'available') schedule[key] = encoded.value
      }
    }
    schedule.timezone = effectiveTimezone(job, context.config || {})
    return {
      name: job.name,
      script: job.script || job.name,
      friendlyName: job.friendlyName,
      description: job.description,
      inputMetadataAvailable: Boolean(job.inputSchema),
      inputs: inputMetadata(job.inputSchema),
      scheduledInputs: scheduledInputs(job),
      schedule,
      scheduleState: {
        registration: 'not_attempted',
        validation: 'not_checked',
        reason: null,
        lastAttemptAt: null,
        ...context.scheduleStates?.get(job.name),
        validationErrors: (
          context.scheduleStates?.get(job.name)?.validationErrors || []
        ).map(({ code, message }) => ({ code, message })),
        restart: restartSemantics(job)
      },
      paused: job.paused,
      withoutOverlapping: job.withoutOverlapping,
      runningCount: context.runtime.active.get(job.name)?.size || 0,
      scheduled: context.timers.has(job.name),
      nextRunAt: context.timers.has(job.name)
        ? context.dueTimes.get(job.name)?.toISOString() || null
        : null,
      runtimeId: context.runtime.runtimeId
    }
  }
  if (name !== undefined) {
    const job = context.jobs.get(name)
    return job ? describe(job) : undefined
  }
  return Array.from(context.jobs.values(), describe)
}
module.exports = {
  createRuntime,
  runtimeInfo,
  inputMetadata,
  scheduledInputs,
  metadata
}
