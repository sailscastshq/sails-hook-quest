# Changelog

## 0.0.6

Quest now exposes the resident execution contract required by job-management integrations while keeping schedules in application source.

### Added

- Process-local runtime identity and capability probes, sanitized input/schema metadata, effective scheduled input previews, running counts, pause state and actual registered timer targets.
- Stable run identity and manual/scheduled provenance on lifecycle events and receipts. Terminal outcomes preserve numeric process exit codes and observed termination signals separately from machine business exits.
- Actual machine business results over a dedicated bounded channel, independent of stdout/stderr. Null, false and zero remain values; unsupported, oversized and nonserializable results are reported explicitly. Bounded diagnostic tails include warnings from successful jobs.
- Bounded schedule registration/validation diagnostics, effective cron timezone precedence and memory-only restart semantics.

### Fixed

- Invalid inputs for source-loaded jobs reject before child launch with `E_QUEST_ADMISSION_REJECTED`, preserving the original Sails validation code. Loaded empty schemas reject unknown inputs; dynamic jobs without metadata keep child-side validation.
- Quest initialization completes only after ORM readiness, jobs and automatic schedules are loaded, and `sails.quest` is published. Successful loaded/ready events and lift callbacks can use the API immediately. Initialization failures reject Sails loading/lifting.
- Owned Sails CLI job children suppress their own automatic Quest schedules after source configuration loads. The resident retains scheduler authority and the child retains application hooks/context.
- Unsafe zero/negative/non-finite/out-of-range recurring intervals and invalid dates/timeouts register no timer. Numeric timeouts must be nonnegative; zero remains an immediate one-shot. These are intentional changes for invalid configuration. Valid expired dates and exhausted cron ranges report no future run rather than invalid configuration.
- Source config aliases preserve original script/schema identity. Allowed overlap state lasts until the final active child completes, and intermediate long-delay timers retain their original target.
- JSON/ref CLI inputs use schema-aware JSON encoding, including ordinary strings, `001` and empty text, while ordinary string inputs keep their literal semantics. Invalid schedules do not prevent an independent manual run with valid business inputs.

### Compatibility and limits

Existing public job-control methods and lifecycle event names remain. New metadata, receipt and event fields are additive. Input precedence remains `job.inputs < scriptInputs < manual inputs`. Pause does not terminate active children; stopping removes future scheduling. All resident scheduling, diagnostics, runtime identity and consumed state are memory-only. Relative intervals/timeouts restart from registration; missed runs are not replayed.

There is no cancellation API, durable execution ledger, distributed lock, workflow builder, second scheduler, automatic retry or transport server. Consumers own transport, authorization, persistence and recovery. See [CONTRACT.md](CONTRACT.md) for exact shapes, bounds and capability gating.
