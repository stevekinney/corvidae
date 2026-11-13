/**
 * COR-2230 — what a durable run of a code agent pins about the agent when it starts or its claim
 * is written, so recovery and a second execution of the claim can tell the agent moved.
 *
 * A code agent's catalog revision never changes with its plugin or its overrides (it reads `1`),
 * so the revision pin-and-warn of a recovered run cannot see either. The pin is two values:
 *
 * - `agentPluginVersion`: the version of a plugin's agent, which is the agent's own `version`
 *   (`PluginAgent.version`) or else its plugin's. A built-in agent has none.
 * - `agentOverrideHash`: the SHA-256 of the agent's overrides in force. An agent with none saved
 *   hashes the empty set, which is the marker for none: a run started with none and one that
 *   finds the overrides saved as the empty set again compare equal.
 *
 * A record that has neither field was written before the pin existed and recovers as it always
 * did.
 *
 * @module agent-definition-pin
 */

/** What a run of a code agent records of the agent's definition. */
export interface AgentDefinitionPin {
  /** The plugin agent's version; absent for a built-in agent, which pins only its overrides. */
  readonly agentPluginVersion?: string | undefined;
  /** The hash of the overrides in force; the empty set's hash when the agent has none saved. */
  readonly agentOverrideHash?: string | undefined;
}

/** One value of a pin that differs between a run's record and the agent now. */
export interface AgentDefinitionDrift {
  readonly field: keyof AgentDefinitionPin;
  /** The value the run recorded, or `undefined` when it recorded none. */
  readonly recorded: string | undefined;
  /** The value the agent has now, or `undefined` when it has none. */
  readonly current: string | undefined;
}

const PIN_FIELDS = ['agentPluginVersion', 'agentOverrideHash'] as const;

/**
 * The fields where `recorded` differs from `current`. A record that pinned nothing predates the
 * pin and never drifts, and an agent with no pin (a file agent, which pins its own definition
 * hash) has nothing to compare, so each gives none.
 */
export function definitionDrift(
  recorded: AgentDefinitionPin,
  current: AgentDefinitionPin | undefined,
): readonly AgentDefinitionDrift[] {
  if (current === undefined) return [];
  if (recorded.agentPluginVersion === undefined && recorded.agentOverrideHash === undefined) {
    return [];
  }
  return PIN_FIELDS.flatMap((field) =>
    recorded[field] === current[field]
      ? []
      : [{ field, recorded: recorded[field], current: current[field] }],
  );
}

/** What a drift says, naming both values of each field. */
export function describeDefinitionDrift(
  agentName: string,
  drift: readonly AgentDefinitionDrift[],
): string {
  const shown = (value: string | undefined) => (value === undefined ? 'none' : value);
  const parts = drift.map(({ field, recorded, current }) =>
    field === 'agentPluginVersion'
      ? `its version was ${shown(recorded)} and is now ${shown(current)}`
      : `its overrides hashed ${shown(recorded)} and now hash ${shown(current)}`,
  );
  return `catalog agent "${agentName}" changed since the run started (${parts.join('; ')})`;
}

/** The pin fields a persisted record or session metadata holds, read as optional strings. */
export function pinOf(agentPluginVersion: unknown, agentOverrideHash: unknown): AgentDefinitionPin {
  return {
    ...(typeof agentPluginVersion === 'string' ? { agentPluginVersion } : {}),
    ...(typeof agentOverrideHash === 'string' ? { agentOverrideHash } : {}),
  };
}
