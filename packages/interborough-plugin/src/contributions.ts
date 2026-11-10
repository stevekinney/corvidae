import type {
  AfterGenerateHook,
  AfterToolExecutionHook,
  BeforeGenerateHook,
  BeforeToolExecutionHook,
  DecisionModel,
  GuardrailEntry,
  HookErrorHandler,
  HookReplayPolicy,
  InputGuardrailAction,
  OnErrorHook,
  OnLLMInputHook,
  OnLLMOutputHook,
  OnRunAbortHook,
  OnRunCompleteHook,
  OnRunErrorHook,
  OnRunStartHook,
  OnStepHook,
  OperativeHookMap,
  OutputGuardrailAction,
  OutputValidator,
  PrepareStepHook,
  RunnableAgent,
  ToolCallValidator,
  ValidateResponseHook,
  ValidateToolResultHook,
  Validator,
} from '@lostgradient/operative';
import type {
  BackendDescriptor,
  ProviderConfigurationBase,
  ProviderDefinition,
} from '@lostgradient/operative/provider-kit';
import type { ActivityDefinition } from '@lostgradient/weft';
import type { AnyTool, Embedder, InputDetector } from 'armorer';
import type { z } from 'zod';

import type { PluginHostApi } from './host-api.ts';
import type { PluginSetupContext } from './plugin-descriptor.ts';
import type { PluginScorer } from './scorer.ts';

/** An event the host publishes, as a trigger, hook action, or formatter receives it. */
export interface PluginEvent {
  /** The event's kind, such as `run.settled`. */
  readonly kind: string;
  /** The Bureau that published the event. */
  readonly bureauId: string;
  /** When the event was published, in milliseconds since the epoch. */
  readonly emittedAtMs: number;
  /** The event's payload. */
  readonly payload: unknown;
  /**
   * The plugin that caused the event through its host API, such as the `schedule.created` of a
   * schedule it created. Absent on an event from Bureau core. It is the event's own field, apart
   * from the payload: a payload key named `source` is the kind's own.
   */
  readonly source?: string;
}

/** A point in governed memory's life at which a memory guardrail runs. */
export type PluginMemoryGate = 'admission' | 'recall';

/**
 * What every guardrail a plugin contributes says about itself besides its name: what it guards, in
 * a sentence a person choosing it reads (`bureau.guardrails.list`). It must not be empty.
 */
export interface PluginGuardrailDescription {
  /** What the guardrail guards, for a listing. Not empty. */
  readonly description: string;
}

/** An input guardrail: an Armorer input detector with a description. */
export type PluginInputGuardrail = InputDetector & PluginGuardrailDescription;

/** An output guardrail: an Operative output validator with a description. */
export type PluginOutputGuardrail = OutputValidator & PluginGuardrailDescription;

/** A tool-call guardrail: an Operative tool-call validator with a description. */
export type PluginToolGuardrail = ToolCallValidator & PluginGuardrailDescription;

/**
 * A guardrail an agent configures (COR-2118): instead of one detector or validator, a plugin
 * contributes what builds one from a configuration. An agent file chooses it as `plugin:name`, or as
 * `{ id: plugin:name, configuration }`; the host parses that configuration (`{}` for the bare id)
 * with {@link configuration} and hands the result to {@link create}, once for each agent that
 * chooses it, so two agents may run it with different settings.
 *
 * A field the agent leaves out takes the schema's default, so the schema's defaults are the
 * plugin-wide ones and an agent's configuration replaces them field by field. A plugin that has a
 * setting of its own for a field writes it into the schema it returns from `setup`, as that
 * field's `.default(...)`.
 *
 * In an input or output group the factory may be wrapped as `{ guardrail: factory, action }`; the
 * action is the plugin's, fixed for every guardrail the factory creates, and an agent's
 * configuration cannot change it. A tool-call factory's guardrail carries its own `action`, as a
 * tool-call validator does.
 */
export interface PluginGuardrailFactory<TGuardrail, TConfiguration = unknown> {
  /** The guardrail's name, claimed within its family, as for a detector or validator. */
  readonly name: string;
  /** What the guardrail guards, for a listing. Not empty. */
  readonly description: string;
  /**
   * The schema an agent's configuration is parsed with. Its JSON Schema is what
   * `bureau.guardrails.list` shows, and a configuration it refuses makes the agent invalid, naming
   * the field.
   */
  readonly configuration: z.ZodType<TConfiguration>;
  /**
   * Builds the guardrail for one agent from its parsed configuration. Its `name` is the factory's;
   * the host replaces any other.
   */
  create(configuration: TConfiguration): TGuardrail;
}

/** An entry of {@link PluginGuardrails.input}. */
export type PluginInputGuardrailEntry = GuardrailEntry<
  PluginInputGuardrail | PluginGuardrailFactory<InputDetector>,
  InputGuardrailAction
>;

/** An entry of {@link PluginGuardrails.output}. */
export type PluginOutputGuardrailEntry = GuardrailEntry<
  PluginOutputGuardrail | PluginGuardrailFactory<OutputValidator>,
  OutputGuardrailAction
>;

/** An entry of {@link PluginGuardrails.tools}. */
export type PluginToolGuardrailEntry =
  PluginToolGuardrail | PluginGuardrailFactory<ToolCallValidator>;

/**
 * A guardrail on governed memory: an Armorer input detector that also says at which points it
 * runs. One object can serve `guardrails.input` and `guardrails.memory` under one name, because
 * names are claimed per family.
 */
export interface PluginMemoryGuardrail extends InputDetector, PluginGuardrailDescription {
  /**
   * Where it runs: `admission` scans content as it is written, `recall` scans each record as it is
   * recalled. Left out, it runs at both. An empty list is refused, since it would run nowhere.
   */
  readonly gates?: readonly PluginMemoryGate[];
}

/**
 * Guardrails a plugin adds to the ones Operative applies to every agent, grouped by what they
 * guard. A guardrail's name is claimed within its family, and the family is recorded in its
 * identity (`plugin:family/name`), so `acme:input/credentials` and `acme:memory/credentials` are
 * different guardrails that may share a name. Every guardrail has a non-empty `description`; an
 * input, output or tool-call guardrail may instead be a {@link PluginGuardrailFactory}, which each
 * agent that chooses it configures.
 */
export interface PluginGuardrails {
  /**
   * Detectors run over the input before a generate call, and over each tool result. An entry is a
   * detector or a factory, which takes the action of the group it joins, or
   * `{ guardrail, action }`, whose `action` (`block`, `warn`, `sanitize` or `tripwire`) it keeps
   * whatever that group's.
   */
  readonly input?: readonly PluginInputGuardrailEntry[];
  /**
   * Validators run over a response before it is accepted. An entry is a validator or a factory,
   * which takes the action of the group it joins, or `{ guardrail, action }`, whose `action`
   * (`block`, `warn`, `redact` or `tripwire`) it keeps whatever that group's.
   */
  readonly output?: readonly PluginOutputGuardrailEntry[];
  /**
   * Validators run over each tool call before it runs, or factories of them. A validator's own
   * `action` (`block`, `warn` or `tripwire`) decides what its finding does; left out, it takes its
   * group's.
   */
  readonly tools?: readonly PluginToolGuardrailEntry[];
  /**
   * Detectors run after the default poisoning detector, on memory admission, on recall or on both
   * (see {@link PluginMemoryGuardrail.gates}). An agent file cannot choose them: they guard the
   * host's memory, not one agent, so none is a factory.
   */
  readonly memory?: readonly PluginMemoryGuardrail[];
}

/**
 * How a plugin declares one hook of an interceptor, beyond the handler. Every field but `handler`
 * is optional, and a hook written as its bare function has none of them.
 */
export interface PluginInterceptorHookOptions<Hook> {
  /** The hook itself. */
  readonly handler: Hook;
  /**
   * Whether the hook may run again when a durable run recovers a step: `safe` for a hook with no
   * external side effect, `effectful` for one that writes outside the run. It is recorded in the
   * run's hook plan, and a hook that declares nothing is `effectful`.
   */
  readonly replay?: HookReplayPolicy;
  /**
   * What to do when the hook throws: `'continue'` runs the next hook as if it had not, and
   * `'abort'` fails the step as before. A hook with no `onError` fails the step. Operative settles
   * the observing points (`onLLMInput`, `onLLMOutput`, `onRunComplete`, `onRunError`,
   * `onRunAbort`) and `onError` itself without asking, so a failure there never fails the run
   * whatever this says.
   */
  readonly onError?: HookErrorHandler;
  /**
   * Where the hook sorts among the run's hooks at its point: a higher number runs first, and a hook
   * that names none sorts at 0. Operative's guardrails sit behind every other agent hook, so the
   * number is raised to just above them when it is lower, and a plugin can never sort behind them.
   * It is also held below 1000, the distance between two tiers' bands, so an interceptor sorts
   * within its own tier: a plugin's hook never runs ahead of Bureau's own invariants, whatever
   * number it asks for. It must be a finite number.
   */
  readonly priority?: number;
}

/**
 * One hook of a {@link PluginInterceptor}: the function itself, or an object that adds how the
 * hook replays, handles its own errors and sorts. The two forms are the same hook.
 */
export type PluginInterceptorHook<Hook> = Hook | PluginInterceptorHookOptions<Hook>;

/**
 * A set of Operative run hooks a plugin contributes under one name. An agent file chooses it with
 * `interceptors: [plugin:name]`, and it runs for the agents that choose it and no others, unless it
 * declares `appliesTo: 'every-agent'`. Each member is an Operative run hook, one for each point of
 * Operative's hook map, written as the function or as {@link PluginInterceptorHookOptions}.
 */
export interface PluginInterceptor {
  /** Names the interceptor in logs and problem reports, and in the id an agent file lists. */
  readonly name: string;
  /**
   * `'every-agent'` runs the set for every run the host starts, whether or not its agent lists it:
   * file agents, code agents, dispatched agents and their children. The host composes it between
   * its own hooks and the agent's. An agent file that also lists it gets it once, as a set it
   * chose. While the plugin needs setup, the set refuses for an agent that lists it, as any chosen
   * set does, and is skipped for every other agent, so it never fails a run that did not choose it.
   * Omitted, the set runs only for the agents that list it.
   */
  readonly appliesTo?: 'every-agent';
  /** Runs before each generate call. */
  readonly prepareStep?: PluginInterceptorHook<PrepareStepHook>;
  /** Runs before the tool calls of a step execute, and may change them. */
  readonly beforeToolExecution?: PluginInterceptorHook<BeforeToolExecutionHook>;
  /** Runs after the tool calls of a step execute. */
  readonly afterToolExecution?: PluginInterceptorHook<AfterToolExecutionHook>;
  /** Runs after each step finishes. */
  readonly onStep?: PluginInterceptorHook<OnStepHook>;
  /** Chooses the tools a step offers the model. */
  readonly selectTools?: PluginInterceptorHook<OperativeHookMap['selectTools']>;
  /** Runs over a response and may reject it. */
  readonly validateResponse?: PluginInterceptorHook<ValidateResponseHook>;
  /** Runs over each tool result and may replace it. */
  readonly validateToolResult?: PluginInterceptorHook<ValidateToolResultHook>;
  /** Runs before compaction; return `false` to cancel it. */
  readonly beforeCompaction?: PluginInterceptorHook<OperativeHookMap['beforeCompaction']>;
  /** Runs before a step requests background compaction; return `false` to withdraw the request. */
  readonly beforeBackgroundCompaction?: PluginInterceptorHook<
    OperativeHookMap['beforeBackgroundCompaction']
  >;
  /** Runs after compaction, with what it removed. */
  readonly afterCompaction?: PluginInterceptorHook<OperativeHookMap['afterCompaction']>;
  /** Chooses the tool choice a step sends the model. */
  readonly selectToolChoice?: PluginInterceptorHook<OperativeHookMap['selectToolChoice']>;
  /** Runs before the generate call and may change what it is given. */
  readonly beforeGenerate?: PluginInterceptorHook<BeforeGenerateHook>;
  /** Runs after the generate call and may change the response. */
  readonly afterGenerate?: PluginInterceptorHook<AfterGenerateHook>;
  /** Observes the input of each generate call; its failure does not fail the run. */
  readonly onLLMInput?: PluginInterceptorHook<OnLLMInputHook>;
  /** Observes the output of each generate call; its failure does not fail the run. */
  readonly onLLMOutput?: PluginInterceptorHook<OnLLMOutputHook>;
  /** Runs when a run starts, before its first step. */
  readonly onRunStart?: PluginInterceptorHook<OnRunStartHook>;
  /** Runs when a run completes; its failure does not fail the run. */
  readonly onRunComplete?: PluginInterceptorHook<OnRunCompleteHook>;
  /** Runs when a run fails, with the error and the partial results; its failure is not reported. */
  readonly onRunError?: PluginInterceptorHook<OnRunErrorHook>;
  /** Runs when a run is aborted; its failure is not reported. */
  readonly onRunAbort?: PluginInterceptorHook<OnRunAbortHook>;
  /** Chooses how a failed generate call recovers: `retry`, `skip` or `abort`. */
  readonly onError?: PluginInterceptorHook<OnErrorHook>;
}

/** What a trigger kind's `start` receives. */
export interface PluginTriggerContext {
  /** The trigger's configuration, parsed with the kind's `configuration` schema. */
  readonly configuration: unknown;
  /** Reports that the trigger fired, with the payload the started work receives. */
  fire(payload: unknown): Promise<void>;
  /** Aborts when the host stops the trigger. */
  readonly signal: AbortSignal;
}

/** A new kind of trigger, an external source that starts work in the host. */
export interface PluginTrigger {
  /** The kind's name, unique within the plugin. */
  readonly name: string;
  /** The kind's own version; a record that pins it uses the plugin's version without one. */
  readonly version?: string;
  /** What the trigger listens for. */
  readonly description: string;
  /** The schema an instance's configuration is parsed with. */
  readonly configuration: z.ZodType;
  /** Starts listening; the function it resolves with stops it. */
  start(context: PluginTriggerContext): Promise<() => void | Promise<void>>;
}

/** What a hook action kind's `run` receives. */
export interface PluginReactionContext {
  /** The event the hook fired for. */
  readonly event: PluginEvent;
  /** The action's configuration, parsed with the kind's `configuration` schema. */
  readonly configuration: unknown;
  /** Aborts when the host stops the delivery. */
  readonly signal: AbortSignal;
  /** The id of the delivery this attempt belongs to; every attempt of one delivery shares it. */
  readonly deliveryId: string;
  /**
   * `hook:<hookId>:<deliveryId>`, the same for every attempt of one delivery and different for each
   * delivery. A run that succeeded and was interrupted before the delivery was marked delivered is
   * attempted again after a restart, so an action with an external effect must use this key (as an
   * idempotency key, or a lookup of what it already did) to make the repeat a no-op.
   */
  readonly idempotencyKey: string;
}

/** A new kind of hook action, what a hook does when one of its events happens. */
export interface PluginReaction {
  /** The kind's name, unique within the plugin. */
  readonly name: string;
  /** The kind's own version; a record that pins it uses the plugin's version without one. */
  readonly version?: string;
  /** What the action does. */
  readonly description: string;
  /** The schema an action's configuration is parsed with. */
  readonly configuration: z.ZodType;
  /** Carries out the action for one event; a rejection is a failed delivery. */
  run(context: PluginReactionContext): Promise<void>;
}

/**
 * A model provider a plugin contributes: Operative's provider definition, with the catalog rows its
 * models appear as. A row's `provider` is the definition's `name`; a row naming another provider
 * is refused when the plugin loads.
 */
export type PluginProvider<Configuration = unknown> = ProviderDefinition<
  string,
  ProviderConfigurationBase,
  Configuration
> & {
  /**
   * The catalog rows of the provider's models. Absent offers Operative's static rows for the
   * definition's `name`, which is what a provider package that ships its models there wants.
   */
  readonly rows?: readonly BackendDescriptor[];
};

/** An embedder the `memory.embedder` setting can name. */
export interface PluginEmbedder {
  /** The embedder's name, unique within the plugin. */
  readonly name: string;
  /** The embedder's own version; a record that pins it uses the plugin's version without one. */
  readonly version?: string;
  /** How many numbers each vector holds. */
  readonly dimensions: number;
  /** Turns texts into vectors, one per text and in order. */
  readonly embed: Embedder;
}

/**
 * An interface panel, an MCP App page, that renders inside the host. The host bundles `entry` into one
 * self-contained page and serves it as the `ui://` resource `uri`, under a content security policy
 * that denies every origin and permission.
 */
export interface PluginPanel {
  /** The app's name, unique within the plugin. */
  readonly name: string;
  /** The app's own version; a record that pins it uses the plugin's version without one. */
  readonly version?: string;
  /** The panel's title. */
  readonly title: string;
  /** What the panel shows. */
  readonly description?: string;
  /**
   * The `ui://` resource the page is served at, unique across plugins. The version is part of the
   * URI: a changed contract is a new one.
   */
  readonly uri: string;
  /** The browser entry module (TypeScript or JavaScript) the host bundles into the page. */
  readonly entry: URL;
  /** The CSS inlined into the page's `<style>` element, so it needs no origin to load from. */
  readonly styles?: string;
  /** The Bureau MCP tool names the panel may call. A panel may call no other tool. */
  readonly allowedTools: string[];
  /** Bureau tools callable only by this host panel, outside the generic MCP inventory. */
  readonly hostOnlyTools?: string[];
  /** An agent tool id that may open this app in an inline Chat tool call. */
  readonly opensFromAgentTool?: string;
  /**
   * The one Bureau MCP tool a client runs to open the page: the host links this tool to the page.
   * It is one of `allowedTools`, and unique across plugins: a tool links to one page, so a plugin
   * whose app opens from a tool another app already opens is skipped with `name-clash`. An app
   * whose entry does not build leaves the plugin running with a `panel-failed` problem.
   */
  readonly opensFromTool: string;
}

/** A rendering of one event for the host's activity views. */
export interface PluginFormatting {
  /** One line naming what happened. */
  readonly title: string;
  /** More detail, when the event has any. */
  readonly body?: string;
}

/** Formats the events of the kinds it names. */
export interface PluginFormatter {
  /** The formatter's name, unique within the plugin. */
  readonly name: string;
  /** The event kinds the formatter handles. */
  readonly eventKinds: readonly string[];
  /** Formats one event of a kind in `eventKinds`. */
  format(event: PluginEvent): PluginFormatting;
}

/** An agent defined in code. */
export interface PluginAgent {
  /** The agent's name, unique within the plugin. */
  readonly name: string;
  /** The agent itself. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the same two-member union Bureau's agent catalog accepts.
  readonly agent: RunnableAgent | RunnableAgent<any, true>;
}

/**
 * An activity a plugin's workflows can call. Its `name` is unique within the plugin; a workflow
 * file names it `plugin:name`, with no version, and its `execute` receives the step's document
 * activity argument (`input`, `trigger`, `previous`, `workflowId`, `step`). The step runs with the
 * rest of the definition: its `retry`, `timeout`, `idempotencyKey`, `verify` and the other settings
 * an activity declares apply, as they do in a code workflow.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an activity's input and output vary per activity.
export type PluginActivity = ActivityDefinition<any, any> & {
  /** The activity's own version; a record that pins it uses the plugin's version without one. */
  readonly version?: string;
};

/**
 * What `setup` returns: everything the plugin adds to the host. Every member is optional, so a
 * plugin names only the kinds it contributes.
 */
export interface PluginContributions {
  /** Tools agents can call. */
  readonly tools?: readonly AnyTool[];
  /** Activities workflows can call. */
  readonly activities?: readonly PluginActivity[];
  /** Goal validators, registered by name and version. */
  readonly validators?: readonly Validator[];
  /** Guardrails added to Operative's defaults. */
  readonly guardrails?: PluginGuardrails;
  /** Interceptors an agent file chooses by name; they run for the agents that choose them. */
  readonly interceptors?: readonly PluginInterceptor[];
  /** Decision models that answer decisions of the kinds they name. */
  readonly decisionRouters?: readonly DecisionModel[];
  /** New kinds of trigger. */
  readonly triggers?: readonly PluginTrigger[];
  /** New kinds of hook action. */
  readonly reactions?: readonly PluginReaction[];
  /** Model providers, each with its catalog rows. */
  readonly providers?: readonly PluginProvider[];
  /** Embedders the `memory.embedder` setting can name. */
  readonly embedders?: readonly PluginEmbedder[];
  /** Scorers that score a sample of completed runs. */
  readonly scorers?: readonly PluginScorer[];
  /** Interface panels. */
  readonly panels?: readonly PluginPanel[];
  /** Event formatters. */
  readonly formatters?: readonly PluginFormatter[];
  /** Agents defined in code. */
  readonly agents?: readonly PluginAgent[];
}

/** What `setup` returns, with the hook the host calls once Bureau has started. */
export interface PluginSetupResult<TConfiguration = unknown> extends PluginContributions {
  /**
   * Runs once after Bureau has started, with the host API and the context `setup` received. A
   * rejection marks the plugin failed without stopping the host.
   */
  afterStart?(
    bureau: PluginHostApi,
    context: PluginSetupContext<TConfiguration>,
  ): void | Promise<void>;
}
