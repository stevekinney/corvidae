import type { GoalBudget, GoalIdentity, ValidatorIdentity } from '@lostgradient/operative';
import type { PaginatedResult, ScheduleFilter, ScheduleSummary } from '@lostgradient/weft';

/** One agent as `PluginHostApi.agents.list` reports it. */
export interface PluginAgentListing {
  /** The agent's identifier. */
  readonly id: string;
  /** The agent's name, which `schedules.create` and `goals.create` take as `agentName`. */
  readonly name: string;
  /** Whether a code definition or an agent file declares the agent. */
  readonly source: 'code' | 'file';
  /** `invalid` when an agent file cannot be used. */
  readonly state: 'ready' | 'invalid';
  /** The agent's description, or `null` when it has none. */
  readonly description: string | null;
}

/** The recurring schedule `PluginHostApi.schedules.create` registers. */
export interface PluginScheduleDefinition {
  /** What the schedule is for. */
  description?: string;
  /** The agent each fire runs. */
  agentName: string;
  /** The message each fire gives the agent. */
  input: string;
  /** When the schedule fires, as the interval or cron text Weft's schedules accept. */
  spec: string;
  /** The session each fire continues; each fire starts its own session without one. */
  sessionId?: string;
  /** Whether a fire starts while the previous one is still running. */
  overlap?: 'skip' | 'allow';
  /** The IANA time zone a cron `spec` is read in. */
  timeZone?: string;
  /** The schedule's owner. */
  principal?: string;
}

/** The durable goal `PluginHostApi.goals.create` starts. */
export interface PluginGoalRequest {
  /** The agent that runs each attempt. */
  readonly agentName: string;
  /** What the agent is asked to achieve. */
  readonly prompt: string;
  /** Stored with the objective, for the conversation policies that seed a conversation from it. */
  readonly instructions?: string | undefined;
  /** Names the goal. */
  readonly identity: GoalIdentity;
  /** The validator, by exact name and version, that decides whether an attempt met the goal. */
  readonly validator: ValidatorIdentity;
  /** How many attempts and how much time the goal may use. */
  readonly bounds: GoalBudget;
  /** The principal that owns the goal. */
  readonly principal?: string | undefined;
  /** Makes the call idempotent: the same request under the same id answers `existing`. */
  readonly goalRunId?: string | undefined;
}

/**
 * What the host serves a plugin's `afterStart`: a structural slice of Bureau, kept narrow so a
 * plugin cannot reach past the calls it is meant to make. `Bureau` satisfies it, and a type test
 * in Bureau keeps that true. The package does not import Bureau, because Bureau depends on it.
 * Its calls are function-typed properties, not methods, so TypeScript checks their parameters
 * strictly and a Bureau request type that grows a required field breaks that test.
 */
export interface PluginHostApi {
  /** The agents the host runs. */
  readonly agents: {
    /** Every agent, code-defined and file-based together. */
    list: () => readonly PluginAgentListing[];
  };
  /** The host's durable schedules. */
  readonly schedules: {
    /** Registers a recurring schedule; answers `undefined` when the host has no durable engine. */
    create: (definition: PluginScheduleDefinition) => Promise<ScheduleSummary | undefined>;
    /** Lists schedules; answers `undefined` when the host has no durable engine. */
    list: (filter?: ScheduleFilter) => Promise<PaginatedResult<ScheduleSummary> | undefined>;
  };
  /** The host's durable goals. */
  readonly goals: {
    /** Starts a goal; `outcome` says whether it was created, already existed, or was rejected. */
    create: (request: PluginGoalRequest) => Promise<{ readonly outcome: string }>;
  };
}
