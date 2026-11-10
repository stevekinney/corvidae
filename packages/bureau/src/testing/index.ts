/**
 * `@lostgradient/bureau/testing`: a Bureau that loads one plugin, for the plugin conformance suite
 * and a plugin's own tests (`plugin-test-host.ts`), and the Bureau's own stores opened over a
 * storage no Bureau is running on, for fixtures that seed records (`seed-stores.ts`).
 *
 * @module testing
 */
export {
  createPluginTestHost,
  type PluginScriptedRunOutcome,
  type PluginScriptedRunRequest,
  type PluginTestHost,
  type PluginTestHostOptions,
} from './plugin-test-host.ts';
export {
  openBureauSeedStores,
  type BureauSeedStores,
  type HookDeliveryAttempt,
  type HookDeliveryRecord,
  type HookRecord,
  type HookStore,
} from './seed-stores.ts';
export {
  WORKSPACE_CONFORMANCE_GROUPS,
  WORKSPACE_EXPECTED_OUTCOMES,
  WORKSPACE_MOUNT_CONFORMANCE,
} from '../http/workspace-conformance.test-support.ts';
