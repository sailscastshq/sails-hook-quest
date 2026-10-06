// @ts-check
const fs = require('node:fs')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** @param {number} pid */
function inspect(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)
  const uid = Number(
    fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^Uid:\s+(\d+)/m)?.[1]
  )
  const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
  return {
    pid,
    state: fields[0],
    group: Number(fields[2]),
    session: Number(fields[3]),
    ticks: fields[19],
    uid,
    env
  }
}
/** Capture only the actual ChildProcess spawned by this executor.
 * @param {import('node:child_process').ChildProcess} child @param {string} runId
 */
function ownProcess(child, runId) {
  if (process.platform !== 'linux' || !child.pid)
    throw new Error('Owned cancellation requires Linux process evidence.')
  const identity = inspect(child.pid)
  if (
    identity.group !== child.pid ||
    identity.session !== child.pid ||
    identity.uid !== process.getuid() ||
    !identity.env.includes(`QUEST_RUN_ID=${runId}`)
  )
    throw new Error('Child process ownership is unconfirmed.')
  let requested = false,
    pending
  function members() {
    const owned = [],
      escaped = []
    for (const file of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(file)) continue
      let item
      try {
        item = inspect(Number(file))
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code)) continue
        // Unreadable unrelated processes need not carry authority for this group.
        const stat = fs
          .readFileSync(`/proc/${file}/stat`, 'utf8')
          .split(') ')
          .pop()
          .split(' ')
        if (!stat[0] || !Number.isSafeInteger(Number(stat[2])))
          throw new Error('Process group membership is unconfirmed.')
        if (stat[0] === 'Z') continue
        if (Number(stat[2]) === identity.group) throw error
        continue
      }
      if (item.state === 'Z') continue
      if (item.group === identity.group) {
        if (
          item.uid !== identity.uid ||
          item.session !== identity.session ||
          !item.env.includes(`QUEST_RUN_ID=${runId}`)
        )
          throw new Error('Process group ownership changed.')
        if (item.pid === identity.pid && item.ticks !== identity.ticks)
          throw new Error('Child PID was reused.')
        owned.push(item)
      } else if (
        item.uid === identity.uid &&
        item.env.includes(`QUEST_RUN_ID=${runId}`)
      )
        escaped.push(item)
    }
    return { owned, escaped }
  }
  const signal = (value) => {
    const evidence = members()
    if (!evidence.owned.length) return
    process.kill(-identity.group, value)
  }
  return {
    get requested() {
      return requested
    },
    get pending() {
      return pending
    },
    cancel() {
      if (pending) return pending
      requested = true
      pending = (async () => {
        try {
          signal('SIGTERM')
          for (let attempt = 0; attempt < 50; attempt++) {
            const evidence = members()
            if (!evidence.owned.length && !evidence.escaped.length)
              return { state: 'cancelled', confirmed: true }
            if (attempt === 20) signal('SIGKILL')
            await delay(100)
          }
        } catch (error) {
          /* Signal/observation failure never establishes termination. */
          return {
            state: 'unconfirmed',
            confirmed: false,
            reason: error.code || error.message
          }
        }
        return { state: 'unconfirmed', confirmed: false }
      })()
      return pending
    }
  }
}
module.exports = { ownProcess }
