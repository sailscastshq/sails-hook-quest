# Resident Quest contract (unreleased v1)

This is the local implementation for upstream issue [#13](https://github.com/sailscastshq/sails-hook-quest/issues/13), based on released main v0.0.5 (`3588713`). The package version is intentionally unchanged pending a separate release decision. Probe `getRuntime().contractVersion` and capabilities; released v0.0.5 has none of these new APIs.

## Resident metadata

`getRuntime()` returns a runtime UUID, `contractVersion: 1`, `scope: 'process'`, and capabilities for input metadata, business results, run identity, and resident state, plus explicit childSchedulerSuppression/triggerProvenance/terminalExitCode probes. Cancellation and durable history are explicitly false.

`metadata()` returns the current registered jobs; `metadata(name)` returns one job or undefined. Each job includes name, original script identity, friendly name/description, `inputMetadataAvailable`, sanitized keyed machine input schema, source-owned schedule, paused/withoutOverlapping flags, active running count, actual timer registration, timer target ISO timestamp (`nextRunAt`, otherwise null), and runtime UUID. Reading metadata neither schedules nor invokes jobs. Pausing blocks new admission and leaves active runs untouched. Timers can stay registered while paused. Stopping removes scheduling, rather than cancelling a child. Pause and scheduling state are process-local and reset when the resident application restarts.

The input schema contains safe JSON constraints, defaults, and examples. Functions are omitted; `customValidation` indicates a custom rule without executing it. Protected/sensitive fields and credential-like names omit defaults/examples. Schema metadata is descriptive, not a substitute for machine validation. `inputMetadataAvailable` is true for source-loaded schemas, including a genuinely empty schema, and false for dynamically added/unloaded definitions without one. In the latter case `inputs: {}` does not claim that the script takes no inputs or supports preflight; typed invocation consumers must gate on the per-job flag. Loaded empty schemas still reject unknown supplied inputs before spawning.

Config aliases use `{name: 'index-from-config', script: 'rebuild-search-index', interval: 10000, inputs: {count: 3}}`. Their schema/defaults come from the original script; events, schedules and overlap guards use the alias's job name. Two aliases intentionally have separate per-job guards, not a script-wide lock.

`scheduledInputs` is separate from schema and manual overrides:

```js
{
  values: {count: 0, enabled: false, payload: null},
  fields: {
    count: {source: 'script_input', sensitive: false, available: true, missingRequired: false},
    requiredValue: {source: 'omitted', sensitive: false, available: false, missingRequired: true},
    secretToken: {source: 'script_input', sensitive: true, available: false, missingRequired: false, reason: 'sensitive'}
  },
  validation: 'not_checked',
  limitBytes: 65536
}
```

These are raw effective scheduled values under the existing precedence `job.inputs < scriptInputs < manual inputs`. Machine schema defaults apply when a value is omitted; `schema_default` describes that fallback. `job_input` and `omitted` are the other source markers. Manual inputs do not change configured scheduled values. No sensitive values are included. Non-JSON, oversized, or budget-limited metadata reports `serialization_error`, `too_large`, or `metadata_limit` instead of a preview. Value previews are capped at 4 KiB per field and 64 KiB total. `missingRequired` flags omitted required values; `validation: 'not_checked'` deliberately does not claim custom/type validation passed.

## Execution and events

The existing signature remains `await sails.quest.run('job-name', inputs)` and returns a receipt array. Multiple names and omitted names retain their existing behavior. Admission checks pause/overlap, validates bounded JSON input and loaded machine schemas without executing business logic, and starts the owned `sails run` child. For source-loaded registered jobs, required/type/custom/unknown-key failures reject before the synchronous start event and before any child is spawned. Ad-hoc scripts or dynamically added jobs lacking loaded schema retain child-side validation; they must not be advertised as supporting full preflight admission. The child's installed Sails/whelk machine runner also validates before invoking the script, using exact typed input through a dedicated pipe. Actual machine output, including named exits, crosses another pipe; stdout is never parsed as a result.

Subscribe to `quest:job:start` before calling `run` to capture the synchronous admission run ID before the child starts. Existing start/complete/error event names and payload fields remain. They gain `runId`, `runtimeId`, `sequence`, `startedAt`, and `trigger: 'manual' | 'scheduled'`; `manual` means public/programmatic `run()`, not an actor or a dashboard attribution; both timer paths supply `scheduled` explicitly. Skips, rejected errors and receipts carry the same trigger; terminal events gain `finishedAt`. Sequence increases across this resident runtime. Skips have a new `quest:job:skip` event and an identified receipt. Admission/validation failures return a rejected Promise (the public `run()` does not synchronously throw), with `error.code: 'E_QUEST_ADMISSION_REJECTED'`, `admission: 'rejected_before_start'`, and `phase: 'validation'`. The original Sails code, such as `E_INVALID_ARGINS`, is retained as `validationCode`. They reject without spawning and have no start event; the error event carries the same admission marker and `error.admissionCode`/`validationCode`. A transport error without this verified marker must not be inferred to be preflight rejection.

A normal terminal receipt looks like:

```js
{
  success: true, duration: 172,
  runId: '...', runtimeId: '...', sequence: 2,
  startedAt: new Date(), finishedAt: new Date(),
  result: {status: 'available', value: {count: 0}},
  logs: {stdout: '...', stderr: 'successful warning',
    stdoutTruncated: false, stderrTruncated: false, limitBytes: 65536}
}
```

`result.status` can be `available`, `undefined`, `unsupported`, `too_large`, or `serialization_error`. Null, false, zero, arrays, and plain JSON objects retain their values. Cycles, getters, non-finite numbers, BigInt, Date/class instances, undefined nested properties, and other non-JSON values are not silently coerced. Depth/node limits also bound traversal. Missing, corrupt, or mismatched envelopes report unsupported with a reason. A successful process does not establish business success.

Sails/whelk deliberately exits process 0 for named machine exits. Preserve that process receipt and expose the actual exit separately: `{success: true, result: {status: 'available', value: 'bad', exit: 'invalid'}}`. A named exit with undefined or unrepresentable data still includes its exit beside the appropriate result status. Errors and non-zero processes reject; their error/event retains bounded diagnostics, identity, duration, and separate log tails. Terminal events, receipts and rejected Errors include `exitCode` as the actual numeric child close code or null when no numeric close code exists. Legacy terminal `event.error.code` remains numeric/null. A generated non-zero rejected Error has no `code`; a native spawn Error retains its string `code` (for example ENOENT) and has `exitCode: null`. Pre-spawn admission rejection has the dedicated string code and no exitCode, because no child existed.

`resultBytes`, `inputBytes`, and `logBytes` each default to 64 KiB and have a 1 MiB hard cap. Logs are independent stdout/stderr tails, with truncation flags; live console output and failure diagnostic tails are retained. No per-run live log-stream API is added.

## Reliability boundary

There is no upstream `readRun`, persisted ledger, event replay, cancellation, distributed lock, second scheduler, workflow builder, or automatic retry. Consumers own their transport, access controls, run correlation, durable retention and reconnection. After resident restart or delivery loss they must label missing evidence as unknown/interrupted rather than fabricate a completed run or retry work. A receipt with missing result transport reports unavailability honestly.

The result transport uses a narrowly scoped CommonJS preload in the owned Sails CLI process, matching only this script's machine completion. The preload marks only this process as an owned execution child. After source config is loaded, its Quest hook sets effective `autoStart: false`, keeping hooks and script context available while registering no automatic schedules. The authoritative resident's source `autoStart` and timers remain intact, and the marker is not inherited by other processes. Other application helpers and script implementations keep their behavior. A custom non-Node runner may complete successfully with unsupported result transport. Validate against each supported Sails/Node version before release; the tests include real Sails CLI, resident Sails/ORM, named exits, and two independent resident processes.

## Local verification

Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run lint`. Tests execute synthetic disposable jobs only. The benchmark is `QUEST_BASELINE_PATH=/absolute/path/to/released/lib/core/executor.js node bench/runtime-contract.js`; it alternates release/current CLI executions for quiet, 2 MiB log, and error cases, then measures bounded serialization/diagnostic copying. Benchmark numbers are samples of this machine, not distributed throughput or exact zero-regression guarantees.
