import type {
  Decision,
  DecisionKind,
  DecisionRequest,
  GoalBudget,
  GoalIdentity,
  ValidatorIdentity,
} from '@lostgradient/operative';
import type { PaginatedResult, ScheduleFilter, ScheduleSummary } from '@lostgradient/weft';

/** One agent as `PluginHost.agents.list` reports it. */
export interface PluginAgentListing {
  /** The agent's identifier. */
  readonly id: string;
  /** The agent's name, which `schedules.create` and `goals.create` take as `agentName`. */
  readonly name: string;
  /** Whether a code definition or an agent file declares the agent. */
  readonly source: 'code' | 'file';
  /**
   * `invalid` when an agent file cannot be used, and `unavailable` for a code agent of a disabled
   * plugin, which is listed but cannot run, so `schedules.create` and `goals.create` refuse it;
   * `disabled` is an agent a person disabled, refused the same way until it is enabled again.
   */
  readonly state: 'ready' | 'invalid' | 'unavailable' | 'disabled';
  /** The agent's description, or `null` when it has none. */
  readonly description: string | null;
}

/** The recurring schedule `PluginHost.schedules.create` registers. */
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

/** The durable goal `PluginHost.goals.create` starts. */
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

/** The options of one `PluginHost.decisions.decide` call. */
export interface PluginDecideOptions {
  /** Cancels the in-flight request. A call whose signal is already aborted rejects without asking a model. */
  readonly signal?: AbortSignal;
  /**
   * The task the decision is made for: its `decision.made` audit record is filed under it, and the
   * event it publishes names it. A non-empty string; the host does not check that the task exists
   * or that the plugin started it. Without one the record is filed under `decision:<uuid>`.
   */
  readonly taskId?: string;
  /**
   * The kinds a model that answers must serve natively. With it set, a model that does not serve
   * every listed kind, and a call the language-model fallback would answer, is refused with
   * `NOT_CONFIGURED` before any model is called, instead of falling back. A non-empty list of
   * decision kinds.
   */
  readonly requireKinds?: readonly DecisionKind[];
}

/**
 * What the host serves a plugin's `start`: a structural slice of Bureau, kept narrow so a
 * plugin cannot reach past the calls it is meant to make. `Bureau` satisfies it, and a type test
 * in Bureau keeps that true. The package does not import Bureau, because Bureau depends on it.
 * Its calls are function-typed properties, not methods, so TypeScript checks their parameters
 * strictly and a Bureau request type that grows a required field breaks that test.
 */
export interface PluginHost {
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
  /**
   * Publishes one of the events the plugin declared (`events` in its setup result) on
   * `bureau.events`, as `<plugin>:<name>` with `source: <plugin>`. The payload is checked against
   * the declared schema, and the event replays after a feed reconnect like any Bureau event.
   * Rejects with a `PluginHostDisposedError` once the Bureau is disposed (a disposed Bureau
   * records and delivers nothing, so the call never resolves having lost the event), with a
   * `TypeError` naming the full kind `<plugin>:<name>` when the plugin declared no such event, with
   * a `TypeError` when the payload fails the declared schema, and with the plugin's needs-setup
   * error while a secret it declared is not set. A rejected call publishes nothing.
   */
  publish: (name: string, payload: unknown) => Promise<void>;
  /** The host's decisions: ask a model a question and get a typed answer back. */
  readonly decisions: {
    /**
     * Answers `request` as the plugin: the host binds the principal `plugin:<name>`, which the
     * `decision.made` audit record names and the model is handed, and no principal the caller
     * passes is used. The call rejects `BAD_REQUEST` for a malformed request, a `taskId` that is not
     * a non-empty string, a `signal` that is not an `AbortSignal`, or `requireKinds` that is not a
     * non-empty list of decision kinds; `NOT_CONFIGURED` when no model can answer (or none that
     * `requireKinds` accepts); the model policy's refusal when the policy forbids the model; and
     * the provider's own error when the provider fails. It rejects with the signal's reason when the
     * signal was already aborted, with a `PluginHostDisposedError` once the Bureau is disposed (a
     * shutdown also aborts a call in flight), and with the plugin's needs-setup error while a secret
     * it declared is not set. A rejected call before the model is asked records nothing. The host
     * adds no deadline and no concurrency limit: a caller that needs one passes a `signal`.
     */
    decide: (request: DecisionRequest, options?: PluginDecideOptions) => Promise<Decision<unknown>>;
  };
}
