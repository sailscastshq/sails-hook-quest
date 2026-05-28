// @ts-check

const defineQuestHook = require('../lib')
const scheduler = require('../lib/core/scheduler')
const loader = require('../lib/core/loader')

/** @typedef {import('../lib/types').QuestSailsApp} QuestSailsApp */
/** @typedef {import('../lib/types').QuestNamedJobDefinition} QuestNamedJobDefinition */

/** @type {QuestSailsApp} */
const sails = {
  config: {
    quest: {
      autoStart: false,
      timezone: 'UTC',
      withoutOverlapping: true,
      jobs: [
        'cleanup-sessions',
        {
          name: 'health-check',
          interval: '5 minutes',
          inputs: { url: 'https://example.com/health' }
        }
      ]
    }
  },
  log: {
    info() {},
    warn() {},
    error() {},
    verbose() {}
  },
  after(_eventName, handler) {
    handler()
  },
  on() {},
  emit() {}
}

const hook = defineQuestHook(sails)
hook.defaults.quest.jobs.push({
  name: 'daily-digest',
  cron: '0 9 * * *',
  timezone: 'Africa/Lagos'
})

/** @type {QuestNamedJobDefinition} */
const dynamicJob = {
  name: 'dynamic-report',
  interval: '1 hour',
  inputs: { format: 'csv' }
}

sails.quest?.add(dynamicJob)
sails.quest?.start(['health-check', 'dynamic-report'])
sails.quest?.run('health-check', { url: 'https://example.com/ping' })
sails.quest?.pause('dynamic-report')
sails.quest?.resume('dynamic-report')
sails.quest?.remove(['dynamic-report'])

const jobs = sails.quest?.list() || []
const firstJob = jobs[0]
if (firstJob) {
  scheduler.getNextRunTime(firstJob, sails.config.quest)
}

loader.addJobDefinition(
  {
    name: 'warm-cache',
    timeout: '10 minutes',
    withoutOverlapping: false
  },
  new Map(),
  sails.config.quest
)

// @ts-expect-error Job names must be strings or string arrays.
sails.quest?.start(123)

// @ts-expect-error Dynamic jobs need a string name when provided as objects.
sails.quest?.add({ name: 123, interval: '5 minutes' })

// @ts-expect-error Dynamic job objects need an explicit name.
sails.quest?.add({ interval: '5 minutes' })
