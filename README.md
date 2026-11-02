# sails-hook-quest

Elegant job scheduling for Sails.js applications. Run scheduled tasks with full access to your Sails app's models, helpers, and configuration.

## Features

- 🕐 **Multiple scheduling formats** - Cron expressions, human-readable intervals, or specific dates
- 🚀 **Full Sails context** - Access models, helpers, and config in your jobs
- 🎯 **Simple API** - Just add a `quest` property to your existing Sails scripts
- 🔄 **Overlap prevention** - Prevent jobs from running concurrently
- 📊 **Event system** - Listen to job lifecycle events for monitoring and alerting
- 🌍 **Environment support** - Run jobs in a minimal 'console' environment for better performance

## Installation

```bash
npm install sails-hook-quest
```

## Reusable Sails execution (next breaking release)

Normal jobs reuse a **separate, fully initialized Sails process**, not the web
application process. Existing script `fn` implementations keep their models,
helpers, configuration, datastore connections, typed inputs and named exits.
There is one active run per child, with a bounded FIFO queue across child slots.
No additional scheduler or Redis service is needed.

```js
// Your existing job stays a Sails script. No execution option is required.
module.exports = {
  friendlyName: 'Process pending tasks',
  quest: {
    interval: '1 minute',
    when: async ({ sails }) =>
      (
        await sails.models.task
          .find({ status: 'queued' })
          .select(['id'])
          .limit(1)
      ).length > 0
  },
  fn: async function () {
    // Atomically claim and process a bounded batch using your existing helpers.
    return sails.helpers.tasks.processPending()
  }
}
```

`when` is an optional **read-only scheduled hint**. False emits a `no_work` skip;
a rejected query is an admission error. Manual `sails.quest.run()` calls bypass
only this hint, not input validation, pause, overlap or capacity controls. A read
deadline does not cancel a query: its admission lock remains until the read
settles. Jobs must still claim records atomically and make external side effects
idempotent. Predicate results grant no permissions.

```js
// Optional capacity policy; these are the defaults.
module.exports.quest = {
  worker: { concurrency: 1, maxQueued: 32, maxRuns: 100, idleTimeoutMs: 60000 }
}
```

Children start lazily, retire after the configured run count and exit after an
idle minute. A warm child retains its Sails memory/connection pool; this trades a
bounded memory floor for fewer cold starts. Queued requests are volatile and
bounded, not a durable business queue. Queue timeout defaults to 60 seconds;
undispatched requests receive an explicit outcome, not a fabricated execution.

### Migration from 0.0.9

This is a breaking execution-default change intended for a new release, **not a
silent patch to published 0.0.9**. To retain fresh CLI execution application-wide:

```js
module.exports.quest = { execution: 'isolated' }
```

Or set `execution: 'isolated'` inside one script's `quest` definition. This is the
right choice for jobs that require a fresh module cache, use `process.exit()` or
`process.argv`, mutate process-wide state, leave unawaited background work, or
need exact CLI stream behavior or a custom `sailsPath` runner. Static detection cannot establish compatibility.
Reusable scripts must await all work; their module/global state persists until
that child retires. Normal default jobs still run outside the HTTP process.

No new execution deadline is imposed by default. Set `executionTimeoutMs` on a
job (or under `quest.worker`) when a runtime budget is appropriate; the existing
job `timeout` option continues to mean **schedule once after a delay**. On Linux,
owned process-tree termination is verified before a timed-out child is replaced.
Unknown termination quarantines its slot and retains overlap ownership; it never
silently starts a replacement. Other platforms retain unconfirmed outcomes when
forced termination cannot be proven. There is no automatic business replay.

`await sails.quest.drain()` stops new admissions, reports queued requests as
undispatched, waits for admitted work, and retires children. Sails' existing
`beforeShutdown` callback is preserved and drain finishes before ORM teardown.
Drain is a shutdown operation; use `stop()`/`start()` for reversible scheduling
control. Deployments still need a sufficient platform termination grace period;
an external hard kill cannot guarantee completion.

Run receipts distinguish run identity from child generation. IPC acceptance is
not proof of business completion. Cancellation never rolls back payments or
emails. A confirmed natural result racing cancellation is retained; crash after
dispatch without that result is interrupted/unknown. Retain application-level
claims and reconcile uncertain external attempts before retrying.

Live output uses bounded per-run snapshots; final logs and business results are
bounded independently. Successful reused runs have `exitCode: null` because the
Sails process remains alive. Fresh CLI runs keep their actual exit codes. See
[CONTRACT.md](CONTRACT.md) for lifecycle details.

## Quick Start

### 1. Create a scheduled job

Create a script in your `scripts/` directory:

```javascript
// scripts/cleanup-sessions.js
module.exports = {
  friendlyName: 'Cleanup old sessions',
  description: 'Remove expired sessions from the database',

  // Add Quest scheduling configuration
  quest: {
    interval: '1 hour', // Human-readable interval
    // or
    cron: '0 * * * *', // Standard cron expression

    withoutOverlapping: true // Prevent concurrent runs
  },

  inputs: {
    daysOld: {
      type: 'number',
      defaultsTo: 30
    }
  },

  fn: async function (inputs) {
    // Full access to Sails models
    const deleted = await Session.destroy({
      lastActive: {
        '<': new Date(Date.now() - inputs.daysOld * 24 * 60 * 60 * 1000)
      }
    }).fetch()

    // Use helpers
    await sails.helpers.sendEmail.with({
      to: 'admin@example.com',
      subject: 'Cleanup complete',
      text: `Deleted ${deleted.length} sessions`
    })

    return { deletedCount: deleted.length }
  }
}
```

### 2. Configure Quest (optional)

```javascript
// config/quest.js
module.exports.quest = {
  // Auto-start jobs on lift
  autoStart: true,

  // Timezone for cron expressions
  timezone: 'UTC',

  // Run jobs in console environment (minimal Sails lift)
  environment: 'console',

  // Retain the final 64 KiB of child output when a job fails
  diagnosticTailBytes: 64 * 1024,

  // Define additional jobs in config
  jobs: [
    {
      name: 'health-check',
      interval: '5 minutes',
      inputs: {
        url: 'https://api.example.com/health'
      }
    }
  ]
}
```

### 3. Listen to job events (optional)

```javascript
// config/bootstrap.js
module.exports.bootstrap = async function () {
  // Job started
  sails.on('quest:job:start', (data) => {
    console.log(`Job ${data.name} started`)
  })

  // Job completed
  sails.on('quest:job:complete', (data) => {
    console.log(`Job ${data.name} completed in ${data.duration}ms`)
    // Send metrics to monitoring service
  })

  // Job failed
  sails.on('quest:job:error', (data) => {
    console.error(`Job ${data.name} failed:`, data.error)
    // Send alert to Slack/Discord/Telegram
  })
}
```

## Scheduling Options

### Human-Readable Intervals

```javascript
quest: {
  interval: '30 seconds'
  interval: '5 minutes'
  interval: '2 hours'
  interval: '7 days'
}
```

### Cron Expressions

```javascript
quest: {
  cron: '0 2 * * *' // Daily at 2 AM
  cron: '*/5 * * * *' // Every 5 minutes
  cron: '0 9 * * MON' // Every Monday at 9 AM
}
```

### One-time Execution

```javascript
quest: {
  timeout: '10 minutes' // Run once after 10 minutes
  date: new Date('2024-12-25') // Run on specific date
}
```

## API

### `sails.quest.run(jobName, inputs?)`

Manually run a job immediately

```javascript
await sails.quest.run('cleanup-sessions', { daysOld: 7 })
```

### `sails.quest.start(jobName?)`

Start scheduling a job (or all jobs if no name provided)

```javascript
sails.quest.start('weekly-report')
```

### `sails.quest.stop(jobName?)`

Stop scheduling a job

```javascript
sails.quest.stop('weekly-report')
```

### `sails.quest.list()`

Get list of all registered jobs

```javascript
const jobs = sails.quest.list()
// [{ name: 'cleanup', interval: '1 hour', ... }]
```

### `sails.quest.pause(jobName)`

Pause a job (prevents execution but keeps schedule)

```javascript
sails.quest.pause('heavy-task')
```

### `sails.quest.resume(jobName)`

Resume a paused job

```javascript
sails.quest.resume('heavy-task')
```

## Events

Quest emits the following events that you can listen to:

- `quest:job:start` - Job execution started
- `quest:job:complete` - Job completed successfully
- `quest:job:error` - Job failed with error

Each event includes:

```javascript
{
  name: 'job-name',
  inputs: { /* job inputs */ },
  timestamp: Date,
  duration: 1234,  // milliseconds (complete/error only)
  error: {
    message: 'Job "job-name" exited with code 1',
    code: 1,
    stack: 'Error: Job "job-name" exited with code 1\\n...',
    diagnostic: 'The final bounded section of the child process output'
  }
}
```

Job output still streams live to the parent process. On failure, Quest also
includes a bounded diagnostic tail and a parent stack in the error event so
observability tools can preserve the useful failure context without buffering
the complete job log.

## Console Environment

Quest can run jobs in a minimal 'console' environment that skips unnecessary hooks for better performance:

```javascript
// config/env/console.js
module.exports = {
  hooks: {
    views: false,
    sockets: false,
    pubsub: false
    // Only load what your jobs need
  }
}
```

```javascript
// config/quest.js
module.exports.quest = {
  environment: 'console' // Use console environment for jobs
}
```

## Examples

### Send Weekly Newsletter

```javascript
// scripts/send-newsletter.js
module.exports = {
  friendlyName: 'Send weekly newsletter',

  quest: {
    cron: '0 9 * * MON', // Every Monday at 9 AM
    withoutOverlapping: true
  },

  fn: async function () {
    const subscribers = await User.find({
      subscribed: true,
      emailVerified: true
    })

    for (const user of subscribers) {
      await sails.helpers.sendEmail.newsletter(user)
    }

    return { sent: subscribers.length }
  }
}
```

### Process Upload Queue

```javascript
// scripts/process-uploads.js
module.exports = {
  friendlyName: 'Process pending uploads',

  quest: {
    interval: '2 minutes',
    withoutOverlapping: true
  },

  fn: async function () {
    const pending = await Upload.find({
      status: 'pending'
    }).limit(10)

    for (const upload of pending) {
      await sails.helpers.processUpload(upload)
      await Upload.updateOne({ id: upload.id }).set({ status: 'processed' })
    }

    return { processed: pending.length }
  }
}
```

### Database Backup

```javascript
// scripts/backup-database.js
module.exports = {
  friendlyName: 'Backup database',

  quest: {
    cron: '0 3 * * *', // Daily at 3 AM
    withoutOverlapping: true
  },

  fn: async function () {
    const backup = await sails.helpers.createDatabaseBackup()

    await sails.helpers.uploadToS3(backup.path)

    await sails.helpers.sendEmail.with({
      to: 'admin@example.com',
      subject: 'Database backup complete',
      text: `Backup saved: ${backup.filename}`
    })

    return { filename: backup.filename }
  }
}
```

## How It Works

Quest's existing resident scheduler owns timers, pause/overlap state and run
identities. For normal execution, a bounded pool reuses separately initialized
Sails contexts. Explicit `execution: 'isolated'` launches the existing
`sails run <script>` path with a fresh Sails process per job. Neither path runs
business code in the web app. Execution children cannot register their own
automatic schedules.

Slipway's resident bridge continues to operate the authoritative scheduler.
Hook integrations must recognize Quest's process-local execution-child marker
before publishing app/Quest/Helm runtimes; a worker app with HTTP disabled alone
does not eliminate cold starts. Existing applications need the corresponding
Slipway-hook compatibility update before adopting reusable execution.

## License

MIT

## Support

- 📖 [Documentation](https://docs.sailscasts.com/sails-quest)
- 🐛 [Report Issues](https://github.com/sailscastshq/sails-hook-quest/issues)
- 💬 [Discord Community](https://discord.gg/gbJZuNm)

---

Built with ❤️ by [The Sailscasts Company](https://sailscasts.com)
