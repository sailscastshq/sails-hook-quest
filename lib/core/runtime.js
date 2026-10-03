// @ts-check
const { randomUUID } = require('node:crypto')
const { encodeResult } = require('./result')

function createRuntime() {
  return { runtimeId: randomUUID(), sequence: 0, active: new Map() }
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
      cancellation: false,
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
          job[key] instanceof Date ? job[key].toISOString() : job[key],
          4096
        )
        if (encoded.status === 'available') schedule[key] = encoded.value
      }
    }
    if (!schedule.timezone)
      schedule.timezone = context.config?.timezone || 'UTC'
    return {
      name: job.name,
      script: job.script || job.name,
      friendlyName: job.friendlyName,
      description: job.description,
      inputs: inputMetadata(job.inputSchema),
      scheduledInputs: scheduledInputs(job),
      schedule,
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
