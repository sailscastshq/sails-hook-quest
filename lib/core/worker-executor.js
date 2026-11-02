// @ts-check
async function executeWorkerLease(
  lease,
  job,
  inputs,
  context,
  identity,
  emit,
  release
) {
  const { runtime, config = {} } = context
  const name = job.name
  let cancellationRequested = false
  runtime.controls.set(identity.runId, {
    cancel: async () => {
      if (!cancellationRequested && runtime.controls.has(identity.runId)) {
        cancellationRequested = true
        emit('quest:job:cancelling', { name, timestamp: new Date() })
      }
      return lease.cancel('cancelled')
    }
  })
  try {
    const receipt = await lease.run(
      {
        script: job.script || name,
        inputs,
        executionTimeoutMs: job.executionTimeoutMs
      },
      (logs) => {
        if (config.runtimeControls)
          emit('quest:job:log', { name, inputs, logs, timestamp: new Date() })
      }
    )
    runtime.controls.delete(identity.runId)
    release()
    const finishedAt = new Date()
    const terminal = {
      name,
      inputs,
      finishedAt,
      timestamp: finishedAt,
      duration: finishedAt.getTime() - identity.startedAt.getTime(),
      logs: receipt.logs,
      result: receipt.result,
      exitCode: null,
      signal: null,
      execution: 'worker',
      workerGeneration: receipt.generation,
      timeoutObserved: receipt.timeoutObserved === true
    }
    const event = emit('quest:job:complete', terminal)
    return { success: true, ...identity, ...terminal, sequence: event.sequence }
  } catch (error) {
    runtime.controls.delete(identity.runId)
    // A timeout is not cancellation. Unconfirmed worker termination retains
    // the overlap lock and quarantined slot until a restart/inspection.
    if (error.confirmed) release()
    const finishedAt = new Date()
    const terminal = {
      name,
      inputs,
      finishedAt,
      timestamp: finishedAt,
      duration: finishedAt.getTime() - identity.startedAt.getTime(),
      logs: error.logs,
      exitCode: error.exitCode ?? null,
      signal: error.signal ?? null,
      execution: 'worker',
      workerGeneration: lease.generation,
      outcome: error.outcome,
      result: error.result,
      cancellationConfirmed: error.confirmed === true,
      error: { message: error.message, code: error.code }
    }
    const event = emit(
      'quest:job:' +
        (error.state === 'failed' ? 'error' : error.state || 'interrupted'),
      terminal
    )
    Object.assign(
      error,
      identity,
      { ...terminal, name: error.name },
      {
        state: error.state,
        sequence: event.sequence
      }
    )
    throw error
  }
}
module.exports = { executeWorkerLease }
