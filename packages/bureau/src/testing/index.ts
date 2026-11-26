/**
 * `@lostgradient/bureau/testing`: a Bureau that loads one plugin, for the plugin conformance suite
 * and a plugin's own tests (`plugin-test-host.ts`), and the Bureau's own stores opened over a
 * storage no Bureau is running on, for fixtures that seed records (`seed-stores.ts`).
 *
 * @module testing
 */
export {
  createPluginTestHost,
  pluginTestModelRows,
  SCRIPTED_MODEL,
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
export {
  createDurableEventHistoryFixture,
  DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE,
  seedSchemaVersionMismatchRecord,
  type DurableEventHistoryFixture,
  type DurableEventHistoryFixtureOptions,
  type DurableEventHistoryFixtureRecord,
} from '../test/durable-event-history-fixture.ts';
export {
  BureauFaultSelectorResolutionError,
  selectAuditWriteFaultTarget,
  selectWebhookDeliveryFaultTarget,
  type BureauFaultOperation,
  type BureauFaultPlan,
  type BureauFaultPlanEntry,
} from '../test/fault-plan.ts';
