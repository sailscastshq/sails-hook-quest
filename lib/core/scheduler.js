// @ts-check

/**
 * core/scheduler.js
 *
 * Functions for parsing schedules and calculating next run times
 */

const later = require('@breejs/later')
const humanInterval = require('human-interval')
const { CronExpressionParser } = require('cron-parser')
const { getGlobalSails } = require('./global-sails')

/** @typedef {import('../types').QuestConfig} QuestConfig */
/** @typedef {import('../types').QuestJobDefinition} QuestJobDefinition */
/** @typedef {import('../types').QuestTimeout} QuestTimeout */

/**
 * Parse various schedule formats and return next run time
 * @param {QuestJobDefinition} job - Job configuration
 * @param {QuestConfig} [config] - Quest configuration
 * @param {(assessment: import('../types').AnyRecord) => void} [report] Bounded parser assessment
 * @returns {Date|null} Next run time or null if invalid
 */
function getNextRunTime(job, config = {}, report = () => {}) {
  const now = new Date()
  const assess = (nextRun, validation, reason = null, code = null) => {
    report({
      validation,
      reason,
      validationErrors: code
        ? [{ code, message: scheduleErrorMessages[code] }]
        : []
    })
    return nextRun
  }
  const invalid = (code) => assess(null, 'invalid', null, code)

  // Preserve the existing conflict exception, but retain its assessment first.
  if (job.date && job.timeout !== undefined && job.timeout !== false) {
    invalid('E_SCHEDULE_CONFLICT')
    throw new Error(
      `Job "${job.name}": Cannot combine 'date' and 'timeout'. Use one or the other.`
    )
  }
  if (job.cron) {
    let interval
    try {
      const options = { tz: effectiveTimezone(job, config) }
      if (job.cronOptions) Object.assign(options, job.cronOptions)
      interval = CronExpressionParser.parse(job.cron, options)
    } catch (err) {
      const sails = getGlobalSails()
      if (sails) sails.log.error(`Invalid cron schedule for job "${job.name}"`)
      return invalid('E_SCHEDULE_CRON')
    }
    try {
      return assess(interval.next().toDate(), 'valid')
    } catch (err) {
      // A parsed cron can be exhausted by its endDate; that is not invalid.
      return assess(null, 'valid', 'no_future_run')
    }
  }
  if (job.interval !== undefined && job.interval !== false) {
    let nextTime = null
    if (typeof job.interval === 'string')
      nextTime = parseInterval(job.interval, now)
    if (
      typeof job.interval === 'number' &&
      Number.isFinite(job.interval) &&
      job.interval > 0
    )
      nextTime = new Date(now.getTime() + job.interval)
    if (!nextTime || !Number.isFinite(nextTime.getTime()) || nextTime <= now)
      return invalid('E_SCHEDULE_INTERVAL')
    return assess(nextTime, 'valid')
  }
  if (job.timeout !== undefined && job.timeout !== false) {
    if (
      typeof job.timeout === 'number' &&
      (!Number.isFinite(job.timeout) || job.timeout < 0)
    )
      return invalid('E_SCHEDULE_TIMEOUT')
    const nextTime = parseTimeout(job.timeout, now)
    if (!nextTime || !Number.isFinite(nextTime.getTime()) || nextTime < now)
      return invalid('E_SCHEDULE_TIMEOUT')
    return assess(nextTime, 'valid')
  }
  if (job.date !== undefined && job.date !== false) {
    if (
      !(job.date instanceof Date) &&
      typeof job.date !== 'string' &&
      typeof job.date !== 'number'
    )
      return invalid('E_SCHEDULE_DATE')
    const date = new Date(job.date)
    if (!Number.isFinite(date.getTime())) return invalid('E_SCHEDULE_DATE')
    return assess(
      date > now ? date : null,
      'valid',
      date > now ? null : 'no_future_run'
    )
  }
  return assess(null, 'not_checked', 'no_schedule')
}

const scheduleErrorMessages = {
  E_SCHEDULE_CONFLICT: 'Date and timeout cannot be combined.',
  E_SCHEDULE_CRON: 'Cron expression, timezone, or parser options are invalid.',
  E_SCHEDULE_INTERVAL:
    'Interval must produce a finite future time; numeric intervals must be positive.',
  E_SCHEDULE_TIMEOUT:
    'Timeout must produce a finite time; numeric timeouts must be nonnegative.',
  E_SCHEDULE_DATE: 'Date must be a supported finite date value.'
}

/** Use the same precedence as cron-parser registration, including explicit tz overrides.
 * @param {QuestJobDefinition} job @param {QuestConfig} [config]
 */
function effectiveTimezone(job, config = {}) {
  return job.cron &&
    job.cronOptions &&
    Object.prototype.hasOwnProperty.call(job.cronOptions, 'tz')
    ? job.cronOptions.tz || null
    : job.timezone || config.timezone || null
}

/**
 * Parse an interval string into a Date
 * @param {String} intervalStr - Interval string like "5 minutes" or "every 2 hours"
 * @param {Date} fromDate - Calculate from this date
 * @returns {Date|null} Next run time or null if can't parse
 */
function parseInterval(intervalStr, fromDate = new Date()) {
  // Convert shorthand format (5s, 10m) to human-interval format
  let processedStr = convertShorthand(intervalStr)

  // Check if it's "every X seconds/minutes" format
  const everyMatch = processedStr.match(
    /^every\s+(\d+)\s+(seconds?|minutes?|hours?|days?)$/i
  )
  if (everyMatch) {
    const amount = parseInt(everyMatch[1])
    const unit = everyMatch[2].replace(/s$/, '') // Remove plural 's'
    /** @type {Record<string, number>} */
    const msMap = {
      second: 1000,
      minute: 60000,
      hour: 3600000,
      day: 86400000
    }
    const ms = amount * msMap[unit]
    if (ms) {
      return new Date(fromDate.getTime() + ms)
    }
  }

  // Check if it's a later.js text expression
  if (processedStr.includes('at') || processedStr.includes('on the')) {
    try {
      const schedule = later.parse.text(processedStr)
      if (schedule.error) {
        throw new Error(schedule.error)
      }
      const next = later.schedule(schedule).next(1)
      if (next) {
        return new Date(next)
      }
    } catch (err) {
      // Silently continue to try other parsers
    }
  }

  // Try human-interval
  try {
    const ms = humanInterval(processedStr)
    if (ms) {
      return new Date(fromDate.getTime() + ms)
    }
  } catch (err) {
    // Return null if can't parse
  }

  return null
}

/**
 * Parse a timeout value into a Date
 * @param {QuestTimeout} timeout - Timeout value
 * @param {Date} fromDate - Calculate from this date
 * @returns {Date|null} Next run time or null
 */
function parseTimeout(timeout, fromDate = new Date()) {
  // String timeout (human-readable)
  if (typeof timeout === 'string') {
    // Check for "at" expressions (e.g., "at 10:00 am")
    if (timeout.startsWith('at ')) {
      try {
        const schedule = later.parse.text(timeout)
        if (!schedule.error) {
          const next = later.schedule(schedule).next(1)
          return next
        }
      } catch (err) {}
    }

    // Try human-interval
    try {
      const ms = humanInterval(timeout)
      if (ms) {
        return new Date(fromDate.getTime() + ms)
      }
    } catch (err) {}
  }

  // Numeric timeout
  if (typeof timeout === 'number') {
    return new Date(fromDate.getTime() + timeout)
  }

  return null
}

/**
 * Convert shorthand format to full format
 * @param {String} str - Input string
 * @returns {String} Converted string
 */
function convertShorthand(str) {
  const shorthandMap = {
    s: ' seconds',
    m: ' minutes',
    h: ' hours',
    d: ' days'
  }

  // Check for shorthand format like '5s', '10m'
  const shorthandMatch = str.match(/^(\d+)([smhd])$/)
  if (shorthandMatch) {
    return shorthandMatch[1] + shorthandMap[shorthandMatch[2]]
  }

  return str
}

module.exports = {
  getNextRunTime,
  effectiveTimezone,
  parseInterval,
  parseTimeout,
  convertShorthand
}
