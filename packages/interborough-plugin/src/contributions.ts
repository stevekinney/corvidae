import type {
  AfterGenerateHook,
  AfterToolExecutionHook,
  BeforeGenerateHook,
  BeforeToolExecutionHook,
  DecisionModel,
  HookErrorHandler,
  HookReplayPolicy,
  OnErrorHook,
  OnLLMInputHook,
  OnLLMOutputHook,
  OnRunAbortHook,
  OnRunCompleteHook,
  OnRunErrorHook,
  OnRunStartHook,
  OnStepHook,
  OperativeHookMap,
  OutputValidator,
  PrepareStepHook,
  RunnableAgent,
  ValidateResponseHook,
  ValidateToolResultHook,
  Validator,
} from '@lostgradient/operative';
import type { BackendDescriptor, ProviderDefinition } from '@lostgradient/operative/provider-kit';
import type { ActivityDefinition } from '@lostgradient/weft';
import type { AnyTool, Embedder, InputDetector } from 'armorer';
import type { z } from 'zod';

import type { PluginHostApi } from './host-api.ts';
import type { PluginSetupContext } from './plugin-descriptor.ts';
import type { PluginScorer } from './scorer.ts';

/** An event the host publishes, as a trigger, hook action, or formatter receives it. */
export interface PluginEvent {
  /** The event's kind, such as `run.completed`. */
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

/** Guardrails a plugin adds to the ones Operative applies to every agent. */
export interface PluginGuardrails {
  /** Detectors run over the input before a generate call. */
  readonly inputDetectors?: readonly InputDetector[];
  /** Validators run over a response before it is accepted. */
  readonly outputValidators?: readonly OutputValidator[];
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
   * It must be a finite number.
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
 * `interceptors: [plugin:name]`, and it runs for the agents that choose it and no others. Each
 * member is an Operative run hook, one for each point of Operative's hook map, written as the
 * function or as {@link PluginInterceptorHookOptions}.
 */
export interface PluginInterceptor {
  /** Names the interceptor in logs and problem reports, and in the id an agent file lists. */
  readonly name: string;
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
export type PluginProvider = ProviderDefinition & {
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
  /** Detectors run after the default poisoning detector, on memory admission and on recall. */
  readonly memoryDetectors?: readonly InputDetector[];
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
