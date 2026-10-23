/**
 * Which of a catalog agent's resolved run options a session run takes from the agent (COR-1577).
 *
 * A session run is built by Bureau, not by the agent: Bureau owns the conversation, the run's
 * identity, its abort signal and its hook and media tiers. The agent owns how it generates and
 * stops, what shape its answer must have, and how that answer is retried. Those agent-owned
 * options must reach the run on all three ways a session run is built (a fresh start, a recovery
 * and a reattach), so the three copy through {@link copyAgentOwnedRunOptions} and nothing else.
 *
 * Every key a `RunOptions` can carry is classified below. The table is typed
 * `satisfies Record<keyof RunOptions, …>`, so an option added to `RunOptions` is a compile
 * error until someone decides whose it is, and a test fails when an agent's resolver returns a
 * key the table does not know.
 *
 * @module session-agent-options
 */

import type { RunOptions } from '@lostgradient/operative';
import type { ToolRequestContext } from 'armorer';

/**
 * Whose a run option is on a session run:
 *
 * - `agent`: the agent's value is carried onto the run unchanged.
 * - `request`: the request's value beats the agent's, which beats the Bureau's default; the
 *   caller resolves the order (`maximumSteps`, `maximumTokens`).
 * - `composed`: Bureau builds it around the agent's value (`generate`, `toolbox`, `hooks`, the
 *   media options, `executeOptions`), so the copy leaves it to the code that composes it.
 * - `run`: it describes this run and is never inherited from an agent's resolution (identity,
 *   conversation, abort signal, tracing, parent links).
 * - `bureau`: Bureau supplies it from its own composition (`runtime`, `sessionId`, `steering`).
 */
export type SessionAgentOptionDisposition = 'agent' | 'request' | 'composed' | 'run' | 'bureau';

export const SESSION_AGENT_OPTION_DISPOSITIONS = {
  generate: 'composed',
  toolbox: 'composed',
  hooks: 'composed',
  contentSourceResolver: 'composed',
  generatedMediaAdmitter: 'composed',
  assetSafety: 'composed',
  executeOptions: 'composed',

  maximumSteps: 'request',
  maximumTokens: 'request',

  stopWhen: 'agent',
  retry: 'agent',
  backpressure: 'agent',
  collectAsync: 'agent',
  onElicitation: 'agent',
  contextManagement: 'agent',
  mediaCostEstimator: 'agent',
  output: 'agent',
  schemaRetries: 'agent',
  schemaRetryMessage: 'agent',
  onMaximumSteps: 'agent',
  durableOperationKeys: 'agent',
  toolChoice: 'agent',
  costEstimation: 'agent',
  selection: 'agent',
  contextEpoch: 'agent',

  conversation: 'run',
  signal: 'run',
  runId: 'run',
  agentName: 'run',
  principal: 'run',
  parentContext: 'run',
  withTraceContext: 'run',
  childCorrelation: 'run',
  childRegistry: 'run',
  delegatedAuthority: 'run',
  parentSignals: 'run',

  runtime: 'bureau',
  sessionId: 'bureau',
  sessionInput: 'bureau',
  steering: 'bureau',
} as const satisfies Record<keyof RunOptions, SessionAgentOptionDisposition>;

type AgentOwnedKey = {
  [
    Key in keyof typeof SESSION_AGENT_OPTION_DISPOSITIONS
  ]: (typeof SESSION_AGENT_OPTION_DISPOSITIONS)[Key] extends 'agent' ? Key : never;
}[keyof typeof SESSION_AGENT_OPTION_DISPOSITIONS];

/** The options {@link copyAgentOwnedRunOptions} carries. */
export const AGENT_OWNED_RUN_OPTION_KEYS = (
  Object.keys(SESSION_AGENT_OPTION_DISPOSITIONS) as Array<
    keyof typeof SESSION_AGENT_OPTION_DISPOSITIONS
  >
).filter(
  (key): key is AgentOwnedKey => SESSION_AGENT_OPTION_DISPOSITIONS[key] === 'agent',
) as readonly AgentOwnedKey[];

/**
 * The agent-owned options of `agentOptions`, ready to spread into a session run's options. An
 * option the agent left unset is left out, so a spread never overwrites a default with
 * `undefined`. Spread it before the options Bureau sets for itself.
 */
export function copyAgentOwnedRunOptions(
  agentOptions: RunOptions | undefined,
): Partial<Pick<RunOptions, AgentOwnedKey>> {
  const copied: Partial<Pick<RunOptions, AgentOwnedKey>> = {};
  if (agentOptions === undefined) return copied;
  for (const key of AGENT_OWNED_RUN_OPTION_KEYS) {
    const value = agentOptions[key];
    if (value !== undefined) Object.assign(copied, { [key]: value });
  }
  return copied;
}

/**
 * The `executeOptions` of a session run: the agent's, with its own `requestContext` dropped, and
 * the session's request context governing (so tool approvals bind to the real session run). With
 * no agent this is the Bureau's alone.
 */
export function sessionExecuteOptions(
  agentOptions: RunOptions | undefined,
  requestContext: ToolRequestContext | undefined,
): NonNullable<RunOptions['executeOptions']> {
  const { requestContext: _ignored, ...rest } = agentOptions?.executeOptions ?? {};
  return requestContext === undefined ? rest : { ...rest, requestContext };
}

/**
 * The run options a scheduled run (a scheduler task or a schedule's fire) takes from its named
 * agent: every agent-owned option, the request's output-token cap and the agent's execute options
 * under the scheduler-issued request context. Both scheduled adapters spread this one projection,
 * so an option cannot reach one and miss the other.
 */
export function scheduledAgentRunOptions(
  agentOptions: RunOptions | undefined,
  requestContext: ToolRequestContext | undefined,
): Partial<Pick<RunOptions, AgentOwnedKey | 'maximumTokens' | 'executeOptions'>> {
  return {
    ...copyAgentOwnedRunOptions(agentOptions),
    ...(agentOptions?.maximumTokens === undefined
      ? {}
      : { maximumTokens: agentOptions.maximumTokens }),
    executeOptions: sessionExecuteOptions(agentOptions, requestContext),
  };
}
