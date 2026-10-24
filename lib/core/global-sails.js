// @ts-check

/** @typedef {import('../types').QuestSailsApp} QuestSailsApp */

/**
 * Resolve the ambient Sails app when core modules run outside the hook factory.
 *
 * @returns {QuestSailsApp | undefined}
 */
function getGlobalSails() {
  return /** @type {{ sails?: QuestSailsApp }} */ (global).sails
}

module.exports = {
  getGlobalSails
}
