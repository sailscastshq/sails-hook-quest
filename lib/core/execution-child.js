// @ts-check
// This state exists only in this Node process. It is never put in the child
// environment, so an unrelated grandchild does not inherit scheduler authority.
let executionChild = false

function markExecutionChild() {
  executionChild = true
}

function isExecutionChild() {
  return executionChild
}

module.exports = { markExecutionChild, isExecutionChild }
