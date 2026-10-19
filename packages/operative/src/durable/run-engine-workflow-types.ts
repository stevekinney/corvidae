/**
 * The workflow types `createRunEngine` registers on a Bureau's engine itself: the durable agent run,
 * the heartbeat tick, and the durable goal. Only the Bureau starts them, with the owner, agent, and
 * validator checks its own operations make, so a caller that starts one through the engine's schedule
 * operations skips those checks.
 *
 * This module imports nothing, so a browser can read the list through the package's
 * `./run-engine-workflow-types` export without taking in the rest of the package. The engine builds
 * its registry from {@link RUN_ENGINE_WORKFLOW_TYPE}, so a type added to it is registered and
 * reserved by one edit, and a registered type left out of it does not compile.
 *
 * @module run-engine-workflow-types
 */

/** The type of each workflow `createRunEngine` registers, by the name the engine knows it by. */
export const RUN_ENGINE_WORKFLOW_TYPE = {
  agentRun: 'agentRun',
  durableHeartbeatTick: 'durableHeartbeatTick',
  goalRun: 'goalRun',
} as const;

/** One of the types `createRunEngine` registers. */
export type RunEngineWorkflowType =
  (typeof RUN_ENGINE_WORKFLOW_TYPE)[keyof typeof RUN_ENGINE_WORKFLOW_TYPE];

/** Every type `createRunEngine` registers, which a host that schedules by type reserves. */
export const RUN_ENGINE_WORKFLOW_TYPES: readonly RunEngineWorkflowType[] =
  Object.values(RUN_ENGINE_WORKFLOW_TYPE);
