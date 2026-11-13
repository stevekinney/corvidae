/**
 * Every `code` a {@link PluginProblem} can carry, with the kind of identity it is about. A code
 * starts with its identity kind (`configuration-invalid`, `panel-failed`) unless it is on the
 * exempt list in `plugin-problem-codes.test.ts`, which the test keeps from growing quietly.
 *
 * @module plugin-problem-codes
 */

/** Problem code to the identity kind the problem is about. */
export const PLUGIN_PROBLEM_CODES = {
  'secret-missing': 'secret',
  'reference-unresolved': 'reference',
  'pinned-version-unavailable': 'contribution',
  'configuration-invalid': 'configuration',
  'name-clash': 'name',
  'activity-field-missing': 'activity',
  'formatter-unknown-kind': 'formatter',
  'provider-secret-unknown': 'provider',
  'provider-secret-ambiguous': 'provider',
  'provider-empty': 'provider',
  'setup-failed': 'plugin',
  'development-source': 'plugin',
  'secret-refused': 'secret',
  'load-failed': 'plugin',
  'panel-failed': 'panel',
  'start-failed': 'plugin',
} as const;

/** A problem code. */
export type PluginProblemCode = keyof typeof PLUGIN_PROBLEM_CODES;
