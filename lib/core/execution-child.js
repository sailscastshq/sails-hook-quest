// @ts-check
// This state exists only in this Node process. It is never put in the child
// environment, so an unrelated grandchild does not inherit scheduler authority.
let executionChild = false
const marker = Symbol.for('sails.quest.executionChild')

function markExecutionChild() {
  executionChild = true
  if (globalThis[marker] !== true)
    Object.defineProperty(globalThis, marker, {
      value: true,
      writable: false,
      configurable: false,
      enumerable: false
    })
}

function isExecutionChild() {
  return executionChild || globalThis[marker] === true
}

module.exports = { markExecutionChild, isExecutionChild }
