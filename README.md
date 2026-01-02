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
  error: { }       // error details (error event only)
}
```

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

Quest leverages the existing `sails run` command to execute jobs. Each job runs as a separate Sails process with full access to your application's context. This approach provides:

1. **Full Sails context** - Models, helpers, and config work exactly as expected
2. **Process isolation** - Jobs can't crash your main application
3. **Simple implementation** - No complex worker thread communication
4. **Familiar patterns** - Jobs are just Sails scripts with scheduling metadata

## License

MIT

## Support

- 📖 [Documentation](https://docs.sailscasts.com/sails-quest)
- 🐛 [Report Issues](https://github.com/sailscastshq/sails-hook-quest/issues)
- 💬 [Discord Community](https://discord.gg/gbJZuNm)

---

Built with ❤️ by [The Sailscasts Company](https://sailscasts.com)
