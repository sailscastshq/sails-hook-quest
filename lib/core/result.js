// @ts-check

const DEFAULT_RESULT_BYTES = 64 * 1024
const MAX_RESULT_BYTES = 1024 * 1024

/** @param {number} [value] */
function byteLimit(value) {
  return Number.isFinite(value) && value > 0
    ? Math.min(MAX_RESULT_BYTES, Math.floor(value))
    : DEFAULT_RESULT_BYTES
}

/**
 * Encode plain JSON without executing getters/toJSON or allocating an unbounded
 * intermediate JSON string. Depth/node limits bound even tiny nested values.
 * @param {any} value
 * @param {number} [requestedBytes]
 * @returns {{status: string, value?: any, json?: string, exit?: string}}
 */
function encodeResult(value, requestedBytes) {
  if (value === undefined) return { status: 'undefined' }
  const limit = byteLimit(requestedBytes)
  const parts = []
  const ancestors = new Set()
  let bytes = 0
  let nodes = 0
  function append(text) {
    bytes += Buffer.byteLength(text)
    if (bytes > limit) throw new RangeError('too_large')
    parts.push(text)
  }
  function visit(item, depth) {
    if (++nodes > 10000 || depth > 64) throw new RangeError('too_large')
    if (item === null) return append('null')
    if (typeof item === 'boolean') return append(String(item))
    if (typeof item === 'number' && Number.isFinite(item))
      return append(String(item))
    if (typeof item === 'string') {
      if (
        item.length > limit - bytes ||
        Buffer.byteLength(item) > limit - bytes
      )
        throw new RangeError('too_large')
      return append(JSON.stringify(item))
    }
    if (typeof item !== 'object') throw new TypeError('non_json')
    if (ancestors.has(item)) throw new TypeError('circular')
    const array = Array.isArray(item)
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    ) {
      throw new TypeError('non_plain_object')
    }
    ancestors.add(item)
    append(array ? '[' : '{')
    const keys = array ? null : Object.keys(item)
    const count = array ? item.length : keys.length
    if (count > 10000) throw new RangeError('too_large')
    for (let i = 0; i < count; i++) {
      if (i) append(',')
      const key = array ? String(i) : keys[i]
      if (!array) {
        if (
          key.length > limit - bytes ||
          Buffer.byteLength(key) > limit - bytes
        )
          throw new RangeError('too_large')
        append(JSON.stringify(key) + ':')
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor || !('value' in descriptor))
        throw new TypeError('non_json_property')
      visit(descriptor.value, depth + 1)
    }
    append(array ? ']' : '}')
    ancestors.delete(item)
  }
  try {
    visit(value, 0)
    const json = parts.join('')
    return { status: 'available', value: JSON.parse(json), json }
  } catch (error) {
    return {
      status: error instanceof RangeError ? 'too_large' : 'serialization_error'
    }
  }
}

module.exports = { encodeResult, byteLimit }
