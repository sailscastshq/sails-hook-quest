const Bree = require('bree')
const path = require('path')
const includeAll = require('include-all')
const getJobsFromScripts = require('./get-jobs-from-scripts')

module.exports = function defineQuestHook(sails) {
  return {
    defaults: {
      quest: {
        // Directory for regular Bree worker jobs (CPU-intensive)
        jobsDir: 'jobs',
        // Additional jobs can be specified here
        jobs: []
      }
    },

    initialize: async function () {
      sails.log.info('Initializing custom hook (`quest`)')

      sails.after('hook:orm:loaded', () => {
        const questConfig = sails.config.quest

        // Scan scripts/ directory for Sails scripts with scheduling properties
        const scriptsDir = path.join(sails.config.appPath, 'scripts')
        let scriptJobs = []

        try {
          const scripts = includeAll({
            dirname: scriptsDir,
            filter: /(.+)\.js$/,
            keepDirectoryPath: true,
            flatten: true
          })

          scriptJobs = getJobsFromScripts(scripts, sails)
          sails.log.verbose(
            `Found ${scriptJobs.length} scheduled scripts in scripts/ directory`
          )
        } catch (error) {
          // scripts/ directory might not exist, that's OK
          sails.log.verbose(
            'No scripts directory found or error loading scripts:',
            error.message
          )
        }

        // Combine script jobs with any additional jobs from config
        const allJobs = [...scriptJobs, ...(questConfig.jobs || [])]
        this.jobs = allJobs

        const breeConfig = {
          ...questConfig,
          logger: sails.log,
          root: path.resolve(sails.config.appPath, questConfig.jobsDir),
          // Set threaded: false globally for script-based jobs
          // Regular Bree worker files in jobs/ can still override this
          threaded: false,
          jobs: allJobs
        }

        const bree = new Bree(breeConfig)
        this.scheduler = bree

        bree.on('worker created', (name) => {
          sails.log.verbose(`Worker created: ${name}`)
        })

        bree.on('worker deleted', (name) => {
          sails.log.verbose(`Worker deleted: ${name}`)
        })

        bree.on('worker error', (error, name) => {
          sails.log.error(`Worker error in job ${name}:`, error)
        })

        if (allJobs.length > 0) {
          bree.start()
          sails.log.info(
            `Quest started with ${allJobs.length} scheduled job(s)`
          )
        } else {
          sails.log.info('Quest initialized but no scheduled jobs found')
        }

        sails.quest = this
        sails.on('lower', async () => {
          sails.log.verbose('Stopping Quest jobs gracefully...')
          await bree.stop()
        })
      })
    }
  }
}
