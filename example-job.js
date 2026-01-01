/**
 * Example Sails Script with Scheduling (goes in scripts/ directory)
 *
 * This shows how to add scheduling to an existing Sails script.
 * The script runs with full Sails context:
 * - this.models.* (User.find(), etc.)
 * - this.helpers.* (all your helpers)
 * - this.config.* (your configuration)
 * - Database connections, etc.
 */

module.exports = {
  friendlyName: 'Cleanup old records',

  description: 'Remove old user sessions and temporary files',

  // Adding these scheduling properties makes it a Quest job:
  cron: '0 2 * * *', // Run every day at 2 AM
  timeout: '5m', // 5 minute timeout

  inputs: {
    daysOld: {
      type: 'number',
      defaultsTo: 30,
      description: 'Remove records older than this many days'
    }
  },

  fn: async function (inputs, done) {
    // Standard Sails script - 'this' is the Sails app instance

    try {
      // Access models directly (Sails script style)
      const oldSessions = await User.find({
        createdAt: {
          '<': new Date(Date.now() - inputs.daysOld * 24 * 60 * 60 * 1000)
        }
      })

      // Use helpers
      if (sails.helpers.cleanup) {
        await sails.helpers.cleanup.tempFiles()
      }

      // Access config
      const maxRecords = this.config.custom.maxRecordsToDelete || 1000

      this.log.info(`Found ${oldSessions.length} old sessions to cleanup`)

      // Delete old sessions in batches
      let deletedCount = 0
      for (const session of oldSessions.slice(0, maxRecords)) {
        await User.destroyOne({ id: session.id })
        deletedCount++
      }

      this.log.info(`Successfully cleaned up ${deletedCount} old records`)

      return done(null, { deletedCount })
    } catch (error) {
      this.log.error('Cleanup script failed:', error)
      return done(error)
    }
  }
}
