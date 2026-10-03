// @ts-check
// Loaded only into the owned CLI child, never into the resident application.
const fs = require('node:fs')
const Module = /** @type {any} */ (require('node:module'))
const path = require('node:path')
const { encodeResult, byteLimit } = require('./result')
const scriptPath = process.env.QUEST_SCRIPT_PATH
const runId = process.env.QUEST_RUN_ID
const limit = byteLimit(Number(process.env.QUEST_RESULT_BYTES))

if (scriptPath && runId) {
  const inputs = JSON.parse(fs.readFileSync(4, 'utf8'))
  require('./execution-child').markExecutionChild()
  // Avoid propagating the contract to grandchildren that do not own these fds.
  delete process.env.QUEST_SCRIPT_PATH
  delete process.env.QUEST_RUN_ID
  delete process.env.QUEST_RESULT_BYTES
  const wrappedFns = new Set()
  let sent = false
  function capture(value, exit) {
    if (sent) return
    sent = true
    const result = encodeResult(value, limit)
    delete result.json
    if (exit) result.exit = exit
    const envelope = JSON.stringify({ version: 1, runId, result })
    // Synchronous write prevents whelk's process.exit from discarding the result.
    const buffer = Buffer.from(envelope)
    let offset = 0
    while (offset < buffer.length)
      offset += fs.writeSync(3, buffer, offset, buffer.length - offset)
  }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments)
    if (request === 'machine' && exported.buildWithCustomUsage) {
      return Object.assign({}, exported, {
        buildWithCustomUsage(options, omen) {
          const wet = exported.buildWithCustomUsage(options, omen)
          if (!wrappedFns.has(options.def.fn)) return wet
          // Keep whelk lifecycle/validation but supply exact JSON values instead
          // of letting CLI parsing turn null/false/0/string values into guesses.
          const configured = function () {
            const deferred = wet(inputs)
            const originalExec = deferred.exec
            deferred.exec = function (callback) {
              return originalExec.call(this, function (error, result) {
                if (!error) capture(result)
                else if (
                  error.name === 'Exception' &&
                  typeof error.exit === 'string'
                )
                  capture(error.raw, error.exit)
                return callback.apply(this, arguments)
              })
            }
            return deferred
          }
          Object.setPrototypeOf(configured, wet)
          return configured
        }
      })
    }
    if (!request.endsWith(path.basename(scriptPath))) return exported
    let resolved
    try {
      resolved = Module._resolveFilename(request, parent)
    } catch {
      return exported
    }
    if (
      resolved !== scriptPath ||
      !exported ||
      typeof exported.fn !== 'function'
    )
      return exported
    wrappedFns.add(exported.fn)
    return exported
  }
}
