/**
 * core/scheduler.js
 *
 * Functions for parsing schedules and calculating next run times
 */

const later = require('@breejs/later')
const humanInterval = require('human-interval')
const { CronExpressionParser } = require('cron-parser')

/**
 * Parse various schedule formats and return next run time
 * @param {Object} job - Job configuration
 * @param {Object} config - Quest configuration
 * @returns {Date|null} Next run time or null if invalid
 */
function getNextRunTime(job, config = {}) {
  const now = new Date()
  const timezone = job.timezone || config.timezone

  // Validate: cannot combine date and timeout
  if (job.date && job.timeout !== undefined && job.timeout !== false) {
    throw new Error(
      `Job "${job.name}": Cannot combine 'date' and 'timeout'. Use one or the other.`
    )
  }

  // Handle cron expressions
  if (job.cron) {
    try {
      const options = { tz: timezone }
      // Merge any cron-parser options (currentDate, startDate, endDate, etc.)
      if (job.cronOptions) {
        Object.assign(options, job.cronOptions)
      }
      const interval = CronExpressionParser.parse(job.cron, options)
      return interval.next().toDate()
    } catch (err) {
      if (global.sails) {
        sails.log.error(
          `Invalid cron expression for job "${job.name}": ${job.cron}`,
          err.message
        )
      }
      return null
    }
  }

  // Handle human-readable intervals
  if (job.interval && typeof job.interval === 'string') {
    const nextTime = parseInterval(job.interval, now)
    if (nextTime) return nextTime

    if (global.sails) {
      sails.log.error(`Invalid interval for job "${job.name}": ${job.interval}`)
    }
    return null
  }

  // Handle numeric intervals (milliseconds)
  if (typeof job.interval === 'number') {
    return new Date(now.getTime() + job.interval)
  }

  // Handle timeout (one-time delay)
  if (job.timeout !== undefined && job.timeout !== false) {
    return parseTimeout(job.timeout, now)
  }

  // Handle specific date
  if (job.date) {
    const date = new Date(job.date)
    if (date > now) {
      return date
    }
  }

  return null
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
 * @param {String|Number} timeout - Timeout value
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
  parseInterval,
  parseTimeout,
  convertShorthand
}
