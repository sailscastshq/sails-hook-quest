// @ts-check
const { fork } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const path = require('node:path')
const { ownProcess } = require('./owned-process')
const { byteLimit, encodeResult } = require('./result')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bounded = (value, fallback, max) =>
  Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback

class WorkerPool {
  constructor(config = {}) {
    this.config = config
    this.options = config.worker || {}
    for (const [key, max] of Object.entries({
      concurrency: 16,
      maxQueued: 128,
      queueTimeoutMs: 3600000,
      maxRuns: 10000,
      startupTimeoutMs: 300000,
      executionTimeoutMs: 3600000,
      idleTimeoutMs: 3600000,
      drainTimeoutMs: 300000,
      retirementTimeoutMs: 300000
    })) {
      const value = this.options[key]
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) ||
          value < (key === 'maxQueued' ? 0 : 1) ||
          value > max)
      )
        throw new Error('Invalid Quest worker ' + key)
    }
    this.concurrency = bounded(this.options.concurrency, 1, 16)
    /** @type {Map<string, any>} */
    this.slots = new Map()
    this.closed = false
    this.queue = []
  }
  acquire(runId, fromQueue = false) {
    if (this.closed) return null
    if (!fromQueue && this.queue.length) return this.enqueue(runId)
    let slot = [...this.slots.values()].find((s) => !s.busy && !s.retiring)
    if (!slot) {
      if (this.slots.size >= this.concurrency)
        return fromQueue ? null : this.enqueue(runId)
      slot = {
        generation: randomUUID(),
        child: null,
        ready: false,
        runs: 0,
        busy: null,
        retiring: false,
        closed: false,
        ownership: null
      }
      slot.exited = new Promise((resolve) => {
        slot.resolveExit = resolve
      })
      slot.retired = new Promise((resolve) => {
        slot.resolveRetired = resolve
      })
      this.slots.set(slot.generation, slot)
    }
    clearTimeout(slot.idleTimer)
    const lease = {
      runId,
      dispatched: false,
      accepted: false,
      stopReason: null,
      completed: false,
      settled: false,
      onLog: null,
      resolve: null,
      reject: null,
      resultBytes: 0,
      logBytes: 0,
      startupTimer: null,
      executionTimer: null,
      pendingStop: null
    }
    slot.busy = lease // Synchronous capacity claim; no unbounded in-memory queue.
    return {
      generation: slot.generation,
      phase: slot.ready ? 'ready' : 'starting',
      run: (request, onLog) => this.run(slot, lease, request, onLog),
      cancel: (reason) => this.stop(slot, lease, reason || 'cancelled')
    }
  }
  enqueue(runId) {
    const limit =
      this.options.maxQueued === 0
        ? 0
        : bounded(this.options.maxQueued, 32, 128)
    if (this.queue.length >= limit) return null
    const item = {
      runId,
      assigned: null,
      request: null,
      onLog: null,
      resolve: null,
      reject: null,
      error: null,
      timer: null
    }
    const cancel = async (reason = 'cancelled') => {
      if (item.assigned) return item.assigned.cancel(reason)
      if (!item.error) {
        item.error = Object.assign(
          new Error('Worker request was not dispatched: ' + reason),
          {
            code: 'E_QUEST_WORKER_' + reason.toUpperCase(),
            state: reason === 'cancelled' ? 'cancelled' : 'interrupted',
            outcome: 'not_dispatched',
            confirmed: true,
            logs: this.logs(null, byteLimit(this.config.logBytes)),
            exitCode: null,
            signal: null
          }
        )
        const index = this.queue.indexOf(item)
        if (index >= 0) this.queue.splice(index, 1)
        clearTimeout(item.timer)
        item.reject?.(item.error)
      }
      return { state: 'cancelled', confirmed: true, notDispatched: true }
    }
    item.timer = setTimeout(
      () => cancel('queue_timeout'),
      bounded(this.options.queueTimeoutMs, 60000, 3600000)
    )
    this.queue.push(item)
    return {
      get generation() {
        return item.assigned?.generation
      },
      get phase() {
        return item.assigned ? 'starting' : 'queued'
      },
      run: (request, onLog) =>
        new Promise((resolve, reject) => {
          item.request = request
          item.onLog = onLog
          item.resolve = resolve
          item.reject = reject
          if (item.error) return reject(item.error)
          if (item.assigned)
            item.assigned.run(request, onLog).then(resolve, reject)
        }),
      cancel
    }
  }
  pump() {
    if (this.closed) return
    while (this.queue.length) {
      const item = this.queue[0]
      const assigned = this.acquire(item.runId, true)
      if (!assigned) return
      this.queue.shift()
      clearTimeout(item.timer)
      item.assigned = assigned
      if (item.request)
        assigned.run(item.request, item.onLog).then(item.resolve, item.reject)
    }
  }
  run(slot, lease, request, onLog) {
    return new Promise((resolve, reject) => {
      lease.resolve = resolve
      lease.reject = reject
      lease.onLog = onLog
      lease.request = request
      lease.resultBytes = byteLimit(this.config.resultBytes)
      lease.logBytes = byteLimit(this.config.logBytes)
      if (lease.stopReason)
        return this.fail(slot, lease, lease.stopReason, true)
      if (slot.ready) return this.dispatch(slot, lease)
      lease.startupTimer = setTimeout(
        () => {
          this.stop(slot, lease, 'startup_timeout').catch(() => {})
        },
        bounded(this.options.startupTimeoutMs, 30000, 300000)
      )
      if (slot.child) return
      const env = {
        ...process.env,
        NODE_ENV: this.config.environment || 'console',
        QUEST_WORKER_GENERATION: slot.generation,
        QUEST_WORKER_APP_PATH: this.config.appPath || process.cwd(),
        QUEST_WORKER_SCRIPTS_DIR: this.config.scriptsDir || 'scripts',
        QUEST_OWNED_RUN_ID: slot.generation
      }
      for (const name of [
        'QUEST_SCRIPT_PATH',
        'QUEST_RUN_ID',
        'QUEST_RESULT_BYTES'
      ])
        delete env[name]
      try {
        slot.child = fork(path.join(__dirname, 'worker-child.js'), [], {
          cwd: env.QUEST_WORKER_APP_PATH,
          env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'ignore', 'ignore', 'ipc']
        })
        slot.child.on('message', (message) => this.message(slot, message))
        slot.child.once('error', () => {
          slot.spawnError = true
        })
        slot.child.once('close', (code, signal) =>
          this.closedSlot(slot, code, signal)
        )
      } catch (error) {
        slot.spawnError = true
        this.closedSlot(slot, null, null)
      }
    })
  }
  async message(slot, message) {
    // Every packet is bound to this actual child generation and current run.
    if (!message || message.generation !== slot.generation || slot.closed)
      return
    if (message.type === 'boot_error' && !slot.ready && slot.busy) {
      slot.busy.bootError = {
        message: String(message.error?.message || 'Sails startup failed').slice(
          0,
          4096
        )
      }
      return
    }
    if (message.type === 'ready') {
      if (slot.ready) return
      if (process.platform === 'linux') {
        const deadline = Date.now() + 1000
        while (!slot.ownership && Date.now() < deadline) {
          try {
            slot.ownership = ownProcess(slot.child, slot.generation)
          } catch {
            await delay(10)
          }
        }
        if (!slot.ownership) {
          if (slot.busy)
            await this.stop(slot, slot.busy, 'ownership_unconfirmed')
          return
        }
      }
      slot.ready = true
      if (slot.busy && !slot.busy.stopReason) this.dispatch(slot, slot.busy)
      return
    }
    const lease = slot.busy
    if (!lease || message.runId !== lease.runId || lease.settled) return
    if (message.type === 'accepted') {
      lease.accepted = true
      return
    }
    if (message.type === 'logs') {
      lease.onLog?.(this.logs(message.logs, lease.logBytes))
      return
    }
    if (message.type !== 'complete') return
    clearTimeout(lease.startupTimer)
    clearTimeout(lease.executionTimer)
    const result = this.result(message.result, lease.resultBytes)
    if (!result) {
      await this.stop(slot, lease, 'invalid_transport')
      return
    }
    if (lease.stopReason) {
      lease.completed = true
      lease.logs = this.logs(message.logs, lease.logBytes)
      if (message.error)
        lease.businessError = {
          message: String(message.error.message || 'Worker job failed').slice(
            0,
            4096
          )
        }
      else
        lease.completeReceipt = {
          result,
          logs: lease.logs,
          generation: slot.generation,
          timeoutObserved: lease.stopReason === 'timed_out'
        }
      return // Positive business evidence still waits for confirmed retirement.
    }
    if (message.error) {
      lease.businessError = {
        message: String(message.error.message || 'Worker job failed').slice(
          0,
          4096
        ),
        stack: String(message.error.stack || '').slice(0, 16384),
        code:
          typeof message.error.code === 'string'
            ? message.error.code.slice(0, 128)
            : undefined
      }
      // Don't reuse a worker after a business exception; await retirement first.
      lease.completed = true
      lease.logs = this.logs(message.logs, lease.logBytes)
      slot.retiring = true
      this.shutdown(slot)
      return
    }
    lease.settled = true
    lease.completed = true
    slot.busy = null
    slot.runs++
    lease.resolve({
      result,
      logs: this.logs(message.logs, lease.logBytes),
      generation: slot.generation
    })
    if (this.closed || slot.runs >= bounded(this.options.maxRuns, 100, 10000)) {
      slot.retiring = true
      this.shutdown(slot)
    } else {
      slot.idleTimer = setTimeout(
        () => {
          slot.retiring = true
          this.shutdown(slot)
        },
        bounded(this.options.idleTimeoutMs, 60000, 3600000)
      )
      slot.idleTimer.unref?.()
    }
    this.pump()
  }
  dispatch(slot, lease) {
    if (lease.dispatched || lease.stopReason || slot.retiring) return
    clearTimeout(lease.startupTimer)
    lease.dispatched = true // send callback success is not proof of execution.
    const executionTimeoutMs =
      lease.request.executionTimeoutMs ?? this.options.executionTimeoutMs
    if (executionTimeoutMs !== undefined)
      lease.executionTimer = setTimeout(() => {
        this.stop(slot, lease, 'timed_out').catch(() => {})
      }, executionTimeoutMs)
    slot.child.send(
      {
        type: 'run',
        generation: slot.generation,
        runId: lease.runId,
        script: lease.request.script,
        inputs: lease.request.inputs,
        resultBytes: lease.resultBytes,
        logBytes: lease.logBytes
      },
      (error) => {
        if (error) this.stop(slot, lease, 'transport_failed').catch(() => {})
      }
    )
  }
  logs(value, limit) {
    const tail = (text) =>
      Buffer.from(typeof text === 'string' ? text : '')
        .subarray(-limit)
        .toString('utf8')
    return {
      stdout: tail(value?.stdout),
      stderr: tail(value?.stderr),
      stdoutTruncated: value?.stdoutTruncated === true,
      stderrTruncated: value?.stderrTruncated === true,
      limitBytes: limit
    }
  }
  result(value, limit) {
    if (
      !value ||
      !['available', 'undefined', 'too_large', 'serialization_error'].includes(
        value.status
      )
    )
      return null
    /** @type {any} */
    let result
    if (value.status === 'available') {
      if (!Object.prototype.hasOwnProperty.call(value, 'value')) return null
      const encoded = encodeResult(value.value, limit)
      result =
        encoded.status === 'available'
          ? { status: 'available', value: encoded.value }
          : { status: encoded.status }
    } else result = { status: value.status }
    if (typeof value.exit === 'string' && value.exit.length <= 128)
      result.exit = value.exit
    return result
  }
  async stop(slot, lease, reason) {
    // A late cancellation cannot affect a subsequent run in the same process.
    if (slot.busy !== lease || lease.settled) {
      if (lease.stopReason && !lease.terminationConfirmed)
        return { state: 'unconfirmed', confirmed: false }
      return {
        state: lease.completed ? 'completed' : 'exited',
        confirmed: true
      }
    }
    if (lease.pendingStop) return lease.pendingStop
    lease.stopReason = reason
    slot.retiring = true
    clearTimeout(lease.startupTimer)
    clearTimeout(lease.executionTimer)
    lease.pendingStop = (async () => {
      if (!slot.child) {
        this.fail(slot, lease, reason, true)
        this.closedSlot(slot, null, null)
        return { state: 'cancelled', confirmed: true, notAdmitted: true }
      }
      if (!slot.ownership && process.platform === 'linux') {
        try {
          slot.ownership = ownProcess(slot.child, slot.generation)
        } catch {
          /* Unproven ownership never authorizes a signal. */
        }
      }
      if (!slot.ownership) {
        // Portable execution is supported, but forced termination is only
        // claimed where the existing Linux ownership contract can prove it.
        slot.child.send?.(
          { type: 'shutdown', generation: slot.generation },
          () => {}
        )
        this.fail(slot, lease, reason, false)
        this.retire(slot, false)
        return { state: 'unconfirmed', confirmed: false }
      }
      const outcome = await slot.ownership.cancel()
      if (!outcome.confirmed) {
        this.fail(slot, lease, reason, false)
        this.retire(slot, false)
        return outcome
      }
      // Signal delivery / child.killed are insufficient: wait for native close.
      await slot.exited
      if (lease.completeReceipt && !lease.settled) {
        lease.settled = true
        lease.terminationConfirmed = true
        lease.resolve(lease.completeReceipt)
      } else
        this.fail(
          slot,
          lease,
          lease.businessError ? 'business_error' : reason,
          true,
          slot.exitCode,
          slot.exitSignal
        )
      this.retire(slot, true)
      return {
        ...outcome,
        state: lease.completeReceipt ? 'completed' : outcome.state,
        confirmed: true
      }
    })()
    return lease.pendingStop
  }
  fail(slot, lease, reason, confirmed, code = null, signal = null) {
    if (lease.settled) return
    lease.settled = true
    lease.terminationConfirmed = confirmed
    clearTimeout(lease.startupTimer)
    clearTimeout(lease.executionTimer)
    const error = Object.assign(
      new Error(
        lease.businessError?.message ||
          lease.bootError?.message ||
          (confirmed
            ? 'Worker run ended: ' + reason
            : 'Worker termination is unconfirmed; do not repeat this run.')
      ),
      {
        code: 'E_QUEST_WORKER_' + reason.toUpperCase(),
        state: confirmed
          ? reason === 'cancelled'
            ? 'cancelled'
            : reason === 'timed_out'
              ? 'timed_out'
              : ['business_error', 'startup_failed', 'spawn_failed'].includes(
                    reason
                  )
                ? 'failed'
                : 'interrupted'
          : 'unconfirmed',
        result: lease.completeReceipt?.result,
        outcome: lease.completeReceipt
          ? 'completed'
          : lease.dispatched && !lease.completed
            ? 'unknown'
            : lease.completed
              ? 'failed'
              : 'not_dispatched',
        confirmed,
        exitCode: typeof code === 'number' ? code : null,
        signal,
        logs: lease.logs || this.logs(null, lease.logBytes),
        workerGeneration: slot.generation
      }
    )
    lease.reject?.(error)
  }
  async closedSlot(slot, code, signal) {
    if (slot.closed) return
    slot.closed = true
    slot.exitCode = code
    slot.exitSignal = signal
    clearTimeout(slot.idleTimer)
    clearTimeout(slot.retirementTimer)
    slot.resolveExit()
    const lease = slot.busy
    if (lease?.pendingStop && slot.ownership) return // stop() must prove group exit.
    const outcome = slot.ownership
      ? await slot.ownership.cancel()
      : {
          confirmed: !lease?.dispatched || lease?.completed === true
        }
    if (lease && !lease.settled)
      this.fail(
        slot,
        lease,
        lease.businessError
          ? 'business_error'
          : lease.stopReason ||
              (lease.bootError
                ? 'startup_failed'
                : slot.spawnError
                  ? 'spawn_failed'
                  : 'crashed'),
        outcome.confirmed === true,
        code,
        signal
      )
    this.retire(slot, outcome.confirmed === true)
  }
  retire(slot, confirmed) {
    if (slot.finalized) return
    if (!confirmed) {
      slot.quarantined = true
      return
    }
    slot.finalized = true
    clearTimeout(slot.retirementTimer)
    this.slots.delete(slot.generation)
    slot.resolveRetired()
    this.pump()
  }
  // Graceful Sails lowering is cooperative. A hung beforeShutdown hook must
  // not strand either an already-completed lease or an idle capacity slot.
  async forceRetirement(slot) {
    if (slot.closed || slot.finalized) return
    if (slot.busy) return this.stop(slot, slot.busy, 'retirement_timeout')
    if (slot.retirementStop) return slot.retirementStop
    slot.retirementStop = (async () => {
      if (!slot.child) return this.retire(slot, true)
      if (!slot.ownership && process.platform === 'linux') {
        try {
          slot.ownership = ownProcess(slot.child, slot.generation)
        } catch {
          // Unverified ownership never authorizes a signal or replacement.
        }
      }
      if (!slot.ownership) return this.retire(slot, false)
      const outcome = await slot.ownership.cancel()
      if (!outcome.confirmed) return this.retire(slot, false)
      await slot.exited
      this.retire(slot, true)
    })()
    return slot.retirementStop
  }
  shutdown(slot) {
    if (slot.closed || slot.shutdownRequested) return
    slot.retiring = true
    slot.shutdownRequested = true
    slot.retirementTimer = setTimeout(
      () => {
        this.forceRetirement(slot).catch(() => this.retire(slot, false))
      },
      bounded(this.options.retirementTimeoutMs, 5000, 300000)
    )
    slot.retirementTimer.unref?.()
    slot.child?.send(
      { type: 'shutdown', generation: slot.generation },
      (error) => {
        if (error)
          this.forceRetirement(slot).catch(() => this.retire(slot, false))
      }
    )
  }
  async drain() {
    this.closed = true
    for (const item of [...this.queue]) {
      clearTimeout(item.timer)
      const error = Object.assign(
        new Error('Worker request was not dispatched: draining'),
        {
          code: 'E_QUEST_WORKER_DRAINING',
          state: 'interrupted',
          outcome: 'not_dispatched',
          confirmed: true,
          logs: this.logs(null, byteLimit(this.config.logBytes)),
          exitCode: null,
          signal: null
        }
      )
      item.error = error
      item.reject?.(error)
    }
    this.queue = []
    const slots = [...this.slots.values()]
    for (const slot of slots) if (!slot.busy) this.shutdown(slot)
    const timeout = bounded(this.options.drainTimeoutMs, 30000, 300000)
    const timer = setTimeout(() => {
      for (const slot of slots)
        if (slot.busy)
          this.stop(slot, slot.busy, 'drain_timeout').catch(() => {})
        else this.forceRetirement(slot).catch(() => this.retire(slot, false))
    }, timeout)
    let deadline
    try {
      await Promise.race([
        Promise.all(slots.map((slot) => slot.retired)),
        new Promise((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                Object.assign(
                  new Error(
                    'Worker drain is unconfirmed; inspect remaining processes, do not replay work.'
                  ),
                  { code: 'E_QUEST_DRAIN_UNCONFIRMED' }
                )
              ),
            timeout + 6000
          )
        })
      ])
    } finally {
      clearTimeout(timer)
      clearTimeout(deadline)
    }
  }
}
module.exports = { WorkerPool }
