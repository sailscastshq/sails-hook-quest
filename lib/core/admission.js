// @ts-check
// A read-only scheduled hint, never a claim or a replacement for job validation.
async function checkScheduledAdmission(job, inputs, context, identity, emit) {
  const runtime = context.runtime
  if (context.trigger !== 'scheduled' || !job.when) return true
  if (typeof job.when !== 'function')
    throw new Error('Quest when must be a function')
  const pending = runtime.admissions || (runtime.admissions = new Map())
  if (pending.has(job.name))
    throw new Error('Quest scheduled admission is already pending')
  const token = {}
  pending.set(job.name, token)
  const timeoutMs = Math.max(
    1,
    Math.min(30000, Number(context.config?.admissionTimeoutMs) || 5000)
  )
  let timer
  let timedOut = false
  const predicate = Promise.resolve().then(() =>
    job.when({ sails: context.sails, inputs, name: job.name })
  )
  // A deadline does not cancel the query. Retain its admission lock until it
  // actually settles; don't start another query behind an unresolved one.
  predicate
    .finally(() => {
      if (pending.get(job.name) === token) pending.delete(job.name)
    })
    .catch(() => {})
  try {
    const answer = await Promise.race([
      predicate,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(
            Object.assign(
              new Error(
                'Quest scheduled admission timed out; the read may still be running.'
              ),
              { code: 'E_QUEST_ADMISSION_TIMEOUT' }
            )
          )
        }, timeoutMs)
      })
    ])
    if (typeof answer !== 'boolean')
      throw new Error('Quest when must return a boolean')
    return answer
  } catch (error) {
    Object.assign(error, identity, {
      code: error.code || 'E_QUEST_ADMISSION_CHECK_FAILED',
      phase: 'scheduled_admission',
      admission: 'rejected_before_start',
      queryUnconfirmed: timedOut
    })
    emit('quest:job:error', {
      name: job.name,
      inputs,
      error: { message: error.message, admissionCode: error.code },
      admission: 'rejected_before_start',
      phase: 'scheduled_admission',
      duration: 0,
      timestamp: new Date(),
      finishedAt: new Date()
    })
    throw error
  } finally {
    clearTimeout(timer)
  }
}
module.exports = { checkScheduledAdmission }
