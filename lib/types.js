/**
 * Shared TypeScript-consumable JSDoc typedefs for Quest's public API.
 *
 * These comments are intentionally colocated with the JavaScript source so JSDoc
 * stays the source of truth for editor autocomplete and local type checks.
 *
 * @typedef {Record<string, any>} AnyRecord
 *
 * @typedef {string | number | boolean | null} JsonPrimitive
 *
 * @typedef {JsonPrimitive | any[] | AnyRecord} JsonValue
 *
 * @typedef {string | number} QuestInterval
 *
 * @typedef {string | number | false} QuestTimeout
 *
 * @typedef {string | number | Date} QuestDateInput
 *
 * @typedef {Record<string, any>} QuestCronOptions
 *
 * @typedef {{
 *   defaultsTo?: any,
 *   type?: string,
 *   description?: string,
 *   required?: boolean,
 *   allowNull?: boolean,
 *   [key: string]: any,
 * }} QuestMachineInputDefinition
 *
 * @typedef {Record<string, QuestMachineInputDefinition>} QuestMachineInputs
 *
 * @typedef {{
 *   name?: string,
 *   friendlyName?: string,
 *   description?: string,
 *   interval?: QuestInterval,
 *   timeout?: QuestTimeout,
 *   cron?: string,
 *   cronOptions?: QuestCronOptions,
 *   date?: QuestDateInput,
 *   timezone?: string,
 *   inputs?: AnyRecord,
 *   scriptInputs?: AnyRecord,
 *   withoutOverlapping?: boolean,
 *   paused?: boolean,
 *   [key: string]: any,
 * }} QuestJobDefinition
 *
 * @typedef {QuestJobDefinition & { name: string }} QuestNamedJobDefinition
 *
 * @typedef {string | QuestNamedJobDefinition} QuestJobDefinitionInput
 *
 * @typedef {{
 *   name: string,
 *   friendlyName: string,
 *   description?: string,
 *   interval?: QuestInterval,
 *   timeout?: QuestTimeout,
 *   cron?: string,
 *   cronOptions?: QuestCronOptions,
 *   date?: QuestDateInput,
 *   timezone?: string,
 *   inputs: AnyRecord,
 *   scriptInputs: AnyRecord,
 *   paused: boolean,
 *   withoutOverlapping: boolean,
 * }} QuestJob
 *
 * @typedef {{
 *   name: string,
 *   inputs?: AnyRecord,
 *   scriptInputs?: AnyRecord,
 *   paused?: boolean,
 *   withoutOverlapping?: boolean,
 * }} QuestExecutableJob
 *
 * @typedef {{
 *   friendlyName?: string,
 *   description?: string,
 *   quest?: QuestJobDefinition,
 *   inputs?: QuestMachineInputs,
 *   fn?: Function,
 *   [key: string]: any,
 * }} QuestScriptDefinition
 *
 * @typedef {string | string[] | null | undefined} QuestJobNameInput
 *
 * @typedef {{
 *   autoStart?: boolean,
 *   timezone?: string,
 *   withoutOverlapping?: boolean,
 *   sailsPath?: string,
 *   environment?: string,
 *   scriptsDir?: string,
 *   appPath?: string,
 *   jobs?: QuestJobDefinitionInput[],
 *   [key: string]: any,
 * }} QuestConfig
 *
 * @typedef {{
 *   skipped: true,
 *   reason: 'already_running' | 'paused',
 * }} QuestSkippedResult
 *
 * @typedef {{
 *   success: true,
 *   duration: number,
 * }} QuestSuccessResult
 *
 * @typedef {QuestSkippedResult | QuestSuccessResult} QuestExecutionResult
 *
 * @typedef {{
 *   name: string,
 *   inputs: AnyRecord,
 *   timestamp: Date,
 * }} QuestJobStartEvent
 *
 * @typedef {{
 *   name: string,
 *   inputs: AnyRecord,
 *   duration: number,
 *   timestamp: Date,
 * }} QuestJobCompleteEvent
 *
 * @typedef {{
 *   message: string,
 *   code?: number | null,
 *   stack?: string,
 * }} QuestJobErrorDetails
 *
 * @typedef {{
 *   name: string,
 *   inputs: AnyRecord,
 *   error: QuestJobErrorDetails,
 *   duration: number,
 *   timestamp: Date,
 * }} QuestJobErrorEvent
 *
 * @typedef {{
 *   start(jobNames?: QuestJobNameInput): Promise<void>,
 *   stop(jobNames?: QuestJobNameInput): void,
 *   run(jobNames?: QuestJobNameInput, inputs?: AnyRecord): Promise<QuestExecutionResult[]>,
 *   add(jobDefs: QuestJobDefinitionInput | QuestJobDefinitionInput[]): string[],
 *   remove(jobNames: QuestJobNameInput): string[],
 *   jobs: QuestJob[],
 *   list(): QuestJob[],
 *   get(name: string): QuestJob | undefined,
 *   isRunning(name: string): boolean,
 *   pause(name: string): boolean,
 *   resume(name: string): boolean,
 * }} QuestApi
 *
 * @typedef {Map<string, QuestJob>} QuestJobsMap
 *
 * @typedef {Map<string, ReturnType<typeof setTimeout>>} QuestTimersMap
 *
 * @typedef {Map<string, number>} QuestRunningMap
 *
 * @typedef {{
 *   jobs: QuestJobsMap,
 *   timers: QuestTimersMap,
 *   running: QuestRunningMap,
 *   config: QuestConfig | null,
 *   scheduleJob: ((name: string) => void) | null,
 *   executeJob: ((name: string, customInputs?: AnyRecord) => Promise<QuestExecutionResult>) | null,
 *   getNextRunTime: ((job: QuestJob) => Date | null) | null,
 * }} QuestContext
 *
 * @typedef {{
 *   jobs?: QuestJobsMap,
 *   timers?: QuestTimersMap,
 *   getNextRunTime?: (job: QuestJob) => Date | null,
 *   executeJob?: (name: string, customInputs?: AnyRecord) => Promise<QuestExecutionResult>,
 * }} QuestScheduleContext
 *
 * @typedef {{
 *   jobs?: QuestJobsMap,
 *   scheduleJob?: (name: string) => void,
 * }} QuestStartContext
 *
 * @typedef {{
 *   jobs?: QuestJobsMap,
 *   timers?: QuestTimersMap,
 * }} QuestStopContext
 *
 * @typedef {{
 *   jobs?: QuestJobsMap,
 *   executeJob?: (name: string, customInputs?: AnyRecord) => Promise<QuestExecutionResult>,
 * }} QuestRunContext
 *
 * @typedef {{
 *   running?: QuestRunningMap,
 *   config?: QuestConfig | null,
 * }} QuestExecutorContext
 *
 * @typedef {{
 *   info(...args: any[]): void,
 *   warn(...args: any[]): void,
 *   error(...args: any[]): void,
 *   verbose(...args: any[]): void,
 *   [key: string]: any,
 * }} QuestLogger
 *
 * @typedef {{
 *   config: {
 *     quest: QuestConfig,
 *     [key: string]: any,
 *   },
 *   log: QuestLogger,
 *   after(eventName: string, handler: Function): void,
 *   on(eventName: string, handler: Function): void,
 *   emit(eventName: 'quest:job:start', payload: QuestJobStartEvent): void,
 *   emit(eventName: 'quest:job:complete', payload: QuestJobCompleteEvent): void,
 *   emit(eventName: 'quest:job:error', payload: QuestJobErrorEvent): void,
 *   emit(eventName: string, payload?: any): void,
 *   quest?: QuestApi,
 *   [key: string]: any,
 * }} QuestSailsApp
 *
 * @typedef {{
 *   defaults: { quest: QuestConfig },
 *   initialize(): Promise<void>,
 *   [key: string]: any,
 * }} QuestSailsHook
 */

module.exports = {}
