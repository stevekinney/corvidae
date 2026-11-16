import type {
  AfterGenerateHook,
  AfterToolExecutionHook,
  BeforeGenerateHook,
  BeforeToolExecutionHook,
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
import type { Storage } from '@lostgradient/storage';
import type { ActivityDefinition, WorkflowDefinition } from '@lostgradient/weft';
import type { AnyTool, Embedder, InputDetector } from 'armorer';
import type { z } from 'zod';

import type { PluginHost } from './host-api.ts';
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

/**
 * What a trigger kind's `start` receives. `TConfiguration` is what the kind's `configuration`
 * schema parses to, so a kind declared through `defineTrigger` reads it with no second parse.
 */
export interface PluginTriggerContext<TConfiguration = unknown> {
  /** The trigger's configuration, parsed with the kind's `configuration` schema. */
  readonly configuration: TConfiguration;
  /** The identifier of the workflow file this trigger starts: `stem`, or `plugin:stem` for a plugin's own file. */
  readonly workflowId: string;
  /**
   * Durable state for this one file, confined to the key prefix
   * `plugin:<name>:trigger:<trigger-name>:<workflow-id>:` (the Weft form of the identifier, so
   * `plugin:stem` is written `plugin__stem`). It survives a restart, a pause, a configuration edit
   * and a plugin upgrade, so a cursor kept here is not lost. It is deleted when the file is
   * deleted, or when the file's trigger becomes another kind; a file that is `invalid` or cannot
   * be read keeps it. Two files that use one kind see disjoint keys.
   *
   * A cursor that depends on the configuration (the account a poll reads, the query it runs)
   * should store a hash of that configuration beside it and reset itself when the hash no longer
   * matches: the host never resets a key on a configuration edit.
   */
  readonly storage: Storage;
  /**
   * Reports that the trigger fired, with the payload the started work receives, and resolves with
   * what the host did: {@link PluginTriggerOutcome}.
   *
   * `options.idempotencyKey` makes a redelivery safe. The host remembers a key per workflow file
   * and trigger kind, for as long as the run it started exists, so a second fire with the same key
   * starts nothing and resolves `duplicate` with the first run's id, whatever state that run is in
   * and whatever its payload was. Once that run is purged, the key is forgotten. Only a fire that
   * starts a run uses its key: a fire the host skipped leaves it free for the redelivery, and so
   * does one that rejected before the run was created (a payload the file refuses, or a start the
   * engine refused). A fire that rejected because the engine's start threw after it had committed
   * the run took the key, so its redelivery resolves `duplicate` with that run. A key that is empty
   * or not a string rejects.
   *
   * A fire after the host stopped the trigger resolves `skipped` and starts nothing; so does one
   * for a file that is paused, or after the host closed. A payload the file's `inputSchema`
   * refuses, one that is not JSON, and a file whose last change the host could not apply reject.
   */
  fire(
    payload: unknown,
    options?: {
      /**
       * A string that names this delivery, such as the id the source gave the event. A non-empty
       * string; at most one run starts for it per workflow file and trigger kind.
       */
      readonly idempotencyKey?: string;
    },
  ): Promise<PluginTriggerOutcome>;
  /**
   * Aborts when the host stops the trigger, and when `start` threw: a `fire` after that resolves
   * `skipped`. For a plugin that declares a secret, the host gives `start` a context of its own
   * each time it runs it: its signal aborts when a secret is removed, and the next `start`
   * receives a new one. For `receive`, it aborts when the request does or the host closes (see
   * {@link PluginTrigger.receive}).
   */
  readonly signal: AbortSignal;
}

/**
 * What the host did with a {@link PluginTriggerContext.fire}: it `started` a run, found the run an
 * earlier fire with the same key started (`duplicate`, with that run's `runId`), or `skipped` the
 * fire because the trigger was stopped, the file is paused, or the host is closed.
 */
export type PluginTriggerOutcome =
  | { readonly outcome: 'started' | 'duplicate'; readonly runId: string }
  | { readonly outcome: 'skipped'; readonly reason: 'stopped' | 'paused' | 'closed' };

/**
 * A new kind of trigger, an external source that starts work in the host. `TSchema` is the
 * `configuration` schema and `start` receives what it parses to; declare a kind with
 * `defineTrigger` to have it inferred from the entry.
 */
export interface PluginTrigger<TSchema extends z.ZodType = z.ZodType> {
  /** The kind's name, unique within the plugin. */
  readonly name: string;
  /**
   * The kind's own version; the plugin's version stands in without one. A change to it restarts
   * the listener of every file that uses the kind, and it is recorded on each run the kind starts.
   */
  readonly version?: string;
  /** What the trigger listens for or receives. */
  readonly description: string;
  /** The schema an instance's configuration is parsed with. */
  readonly configuration: TSchema;
  /**
   * Starts listening; the function it resolves with stops it. A kind defines `start`, `receive` or
   * both: one with neither is refused when its plugin loads. A kind with only `receive` has no
   * listener to run, and its files report the listener state `ready`.
   */
  start?(context: PluginTriggerContext<z.output<TSchema>>): Promise<() => void | Promise<void>>;
  /**
   * Answers one inbound request for a workflow file of this kind, called by the host's
   * `receiveTrigger(id, request)` (the `POST /triggers/<workflow-id>` route calls it). It receives
   * the request as the host was given it, unread, and the same context `start` receives:
   * `configuration` is the file's, parsed, `workflowId` its identifier, and `storage` the same
   * state `start` sees. It authenticates the sender itself (see `verifyHmacSignature`) and
   * resolves the `Response` the sender is answered with; the host returns that object as it is. It
   * calls `context.fire` for each run it starts, with `options.idempotencyKey` for a delivery that
   * may be repeated: the host reads no header and applies no key of its own. There is no timestamp
   * window, so a captured signed delivery verifies again however late it is sent, and the key is
   * the only replay protection: take it from data the signature covers (a field of the verified
   * body, or a digest of its bytes), never from a header the signature does not cover.
   *
   * `context.signal` aborts when the request does and when the host closes, and for nothing else:
   * a pause, an edit, a removal or a new version of the kind does not abort a call in flight. A
   * `fire` after it aborted, or after the host closed, resolves `skipped` and starts nothing. A
   * `fire` for a paused file resolves `skipped: 'paused'`, so `receive` still answers the sender.
   * A rejection, including one for a secret the plugin declares and has not been given
   * (`PluginNeedsSetupError`), goes back to the caller as it is, changes nothing about the file's
   * listener, and is reported nowhere: the host's route answers a status with no text.
   */
  receive?(request: Request, context: PluginTriggerContext<z.output<TSchema>>): Promise<Response>;
}

/** What a hook action kind's `run` receives. */
export interface PluginReactionContext {
  /** The event the hook fired for. */
  readonly event: PluginEvent;
  /** The action's configuration, parsed with the kind's `configuration` schema. */
  readonly configuration: unknown;
  /**
   * Aborts when the host stops the delivery (a shutdown), when the reaction's `timeoutMilliseconds`
   * have passed, and when the hook is disabled or deleted. The attempt ends when it aborts, whether
   * or not `run` looks at it: pass it to whatever `run` waits on so the work stops too.
   */
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
  /**
   * How long one attempt of `run` may take, in milliseconds: a positive safe integer, or the host
   * skips the plugin (a `setup-failed` problem naming the reaction and the value). When it passes,
   * the context's `signal` aborts, the attempt ends in error
   * (`The reaction timed out after N ms`) and is tried again. Absent, an attempt gets the host's
   * webhook request timeout (10 seconds unless the host sets another). A delivery's lease lasts at
   * least this long, so a second process never takes over a `run` still inside its timeout.
   */
  readonly timeoutMilliseconds?: number;
  /**
   * The schema an action's configuration is parsed with. Mark a field that holds a secret (an API
   * key, a webhook token) with `.meta({ secret: true })`: a hook then stores `{ "$secret": "<key>" }`
   * in that field, where the key names a secret the workspace has published, and never the value; a
   * plain value in the field is refused when the hook is written. Each attempt of a delivery
   * resolves the key to the value published then, and `run` receives the value in `configuration`,
   * as the schema declares it (a string). An attempt whose key has no value fails and is tried
   * again, and never falls back to another value. Mark only fields reached through an object's
   * properties, optional or not: a marker under an array or a record, and a marked field that
   * is a union, are refused, because a reference has no single place to be kept there. `.nullable()`
   * makes a union, so both `.meta({ secret: true }).nullable()` and `.nullable().meta({ secret: true })`
   * are refused; use `.optional()` instead. A `{ secret: true }` inside a `default` or `examples`
   * value is data, not a marker.
   */
  readonly configuration: z.ZodType;
  /**
   * Carries out the action for one event. A rejection fails that attempt, and the delivery is tried
   * again until it runs out of attempts. Reject with a `PluginReactionError` whose `permanent`
   * is `true` when a retry cannot change the answer (the channel does not exist, the service
   * refuses the input for good): the delivery then ends `failed` after that one attempt.
   */
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
   * The catalog rows of the provider's models, which the provider's own package ships. Absent, the
   * provider offers no model and its plugin records a `provider-empty` problem.
   */
  readonly rows?: readonly BackendDescriptor[];
  /**
   * The key of the plugin's declared secret that holds the provider's API key. Composition refuses
   * a key the plugin does not declare (`provider-secret-unknown`). Absent, a plugin that declares
   * exactly one secret uses it, a plugin that declares none has a keyless provider (called with no
   * `apiKey`), and a plugin that declares several is refused (`provider-secret-ambiguous`).
   */
  readonly secretKey?: string;
  /**
   * The provider's own version, recorded in the plugin's identities beside the native decision kinds
   * of its rows (COR-2158); the plugin's version without one. Change it when the provider's native
   * decision behavior changes.
   */
  readonly version?: string;
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
 * Where a panel appears in the host (COR-2212). A panel declares each place it opens, so a page
 * panel needs no MCP tool to open from, and a place several plugins can fill takes no claim.
 * Setup refuses a placement with another `kind`, a `page` group outside `work`, `build` and
 * `system`, and a `page` path outside `^[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)*$`.
 */
export type PluginPanelPlacement =
  | {
      /** The panel is a page of its own in the host's router. */
      readonly kind: 'page';
      /** The route path under the host, in lowercase segments of letters, digits and hyphens. */
      readonly path: string;
      /** A sidebar entry for the page; without one the page is reachable only by its path. */
      readonly sidebar?: {
        /** The sidebar group the entry sits in. */
        readonly group: 'work' | 'build' | 'system';
        /** The name of a Lucide icon drawn beside the entry. */
        readonly icon?: string;
      };
    }
  | {
      /** The panel shows on a run's page, beside the run it belongs to. */
      readonly kind: 'run';
    }
  | {
      /** The panel opens inline in Chat from a tool call of the agent tool `agentTool`. */
      readonly kind: 'chat-tool';
      /**
       * The agent tool id whose call opens the panel. A Bureau given its agent tools refuses an
       * id it does not hold, except the workflow tools it adds itself.
       */
      readonly agentTool: string;
    };

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
   * The `ui://` resource the page is served at. It begins `ui://<plugin>/`, the contributing
   * plugin's own name, so two plugins never hold one URI: setup refuses any other prefix. The
   * version is part of the URI: a changed contract is a new one, and a start that serves
   * different bytes under a URI an earlier start served lists a `panel-changed` problem (the page
   * is still served).
   */
  readonly uri: string;
  /** The browser entry module (TypeScript or JavaScript) the host bundles into the page. */
  readonly entry: URL;
  /** The CSS inlined into the page's `<style>` element, so it needs no origin to load from. */
  readonly styles?: string;
  /** The Bureau MCP tool names the panel may call. A panel may call no other tool. */
  readonly allowedTools: string[];
  /**
   * Bureau operations callable only by this host panel, outside the generic MCP inventory. Each
   * is one of `allowedTools`, and must be in the Bureau's `HOST_PANEL_OPERATIONS`: setup refuses
   * any other name, and the host answers 403 for it.
   */
  readonly hostOnlyTools?: string[];
  /**
   * Where the panel appears in the host. A panel that declares none is served and linked from
   * `opensFromTool` alone. Two plugins' panels can both have a `run` placement: a placement is no
   * claim on a name.
   */
  readonly placements?: readonly PluginPanelPlacement[];
  /**
   * The one Bureau MCP tool a client runs to open the page: the host links this tool to the page.
   * It is one of `allowedTools`, and unique across plugins: a tool links to one page, so a plugin
   * whose app opens from a tool another app already opens is skipped with `name-clash`. Without
   * one, no tool links to the page and nothing is claimed, so a page panel needs no MCP opener. An
   * app whose entry does not build leaves the plugin running with a `panel-failed` problem.
   */
  readonly opensFromTool?: string;
}

/** A rendering of one event for the host's activity views. */
export interface PluginFormatting {
  /** One line naming what happened. */
  readonly title: string;
  /** More detail, when the event has any. */
  readonly body?: string;
  /**
   * How much the event matters to whoever reads the activity view. Without one, or with any other
   * value, the event is `info`.
   */
  readonly tier?: 'critical' | 'warning' | 'info';
  /** The name of a Lucide icon the view draws beside the title. */
  readonly icon?: string;
  /**
   * Where the view sends the reader for more, as a path in the host's router: it starts with one
   * `/` and holds no whitespace or control character. The host drops any other value (a URL, a
   * `//host` path, a relative path, a path with a tab or line break), so a plugin cannot point the
   * view at another origin.
   */
  readonly link?: string;
}

/** Formats the events of the kinds it names. */
export interface PluginFormatter {
  /** The formatter's name, unique within the plugin. */
  readonly name: string;
  /** The event kinds the formatter handles. */
  readonly eventKinds: readonly string[];
  /**
   * Formats one event of a kind in `eventKinds`, from the event alone and synchronously: it is
   * handed no storage, no secrets and no other event, and returns no promise. The host keeps a
   * `title` to one line of 200 characters (newlines become spaces) and a `body` to 2,000
   * characters, cutting a longer one, and drops a `body` that is not a string.
   */
  format(event: PluginEvent): PluginFormatting;
}

/**
 * Where an agent is offered: `chat` agents are offered in Chat's agent list. A `hidden` agent is
 * still listed by `bureau.agents.list`, which carries `visibility: "hidden"` for it, and a client
 * that offers agents for a chat leaves it out (Chat does); a workflow's `agent` step, a child or a
 * direct start can still run it by its `plugin:name`.
 */
export type PluginAgentVisibility = 'chat' | 'hidden';

/** An agent defined in code. */
export interface PluginAgent {
  /** The agent's name, unique within the plugin. */
  readonly name: string;
  /** A label for the agent's listing; the listing falls back to the agent's own name without one. */
  readonly title?: string;
  /**
   * Where the agent is offered. Without it the agent is `chat`. Use `hidden` for an agent only a
   * workflow or a parent agent runs.
   */
  readonly visibility?: PluginAgentVisibility;
  /**
   * The agent's own version. A run of the agent pins it in place of the plugin's version, as an
   * activity's `version` does, and a run recovered under a different version settles failed with
   * `definition-drifted` instead of resuming under a definition it did not start with.
   */
  readonly version?: string;
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
  /** What the workflow editor calls the activity. Required: setup fails without it. */
  readonly title: string;
  /**
   * The schema of the input a step gives the activity. Required (D7): the editor derives the
   * step's fields from it, so a plugin that names no schema fails setup.
   */
  readonly inputSchema: NonNullable<ActivityDefinition<any, any>['inputSchema']>;
};

/**
 * A workflow defined in code, as Weft's `workflow({ name }).execute(...)` builds it. Its `name` is
 * unique within the plugin; the host registers it as `plugin:name`, lists it beside the workflow
 * files, and starts it with the envelope a workflow file's run starts with (`{ kind, input,
 * origin, workspaceAuthority? }`), after checking `inputSchema` against the envelope's `input`. A
 * workflow file of the same plugin cannot carry the same name, and a plugin that is disabled takes
 * its workflows with it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a workflow's input, output and services vary per workflow.
export type PluginWorkflow = WorkflowDefinition<any, any, string, any> & {
  /**
   * The workflow's own version. A run pins it in place of the plugin's version, and it is the
   * version the engine registers the workflow at.
   */
  readonly version?: string;
  /** What the workflow list calls the workflow. Required: setup fails without it. */
  readonly title: string;
  /** The schema of the input a start gives the workflow. Required (D7): setup fails without it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the input type varies per workflow.
  readonly inputSchema: NonNullable<WorkflowDefinition<any, any, string, any>['inputSchema']>;
};

/**
 * An event kind a plugin declares. The kind is `<plugin>:<name>`, so no two plugins can hold one,
 * and none can hold a kind Bureau itself publishes (those have no `:`). A declared kind is listed
 * by `bureau.events.catalog` with the fields of its payload, and a plugin's own identity records
 * it as an `event` with a digest of `payload`.
 *
 * A payload carries identifiers, statuses and counts, never content (an event reaches hooks,
 * activity views and other plugins, and is not the place a document or a message travels). The
 * host refuses a plugin whose payload could carry content, with `event-payload-content`. A field
 * is accepted when every value it can hold is a number, a boolean, a literal, a `z.enum` (a status),
 * or a string marked `.meta({ identifier: true })`, an identifier of a thing held elsewhere; a
 * nested object, array, union or optional of such values is accepted too. A free `z.string()`,
 * `z.unknown()`, `z.any()`, `z.record()` and an object with a catchall are refused.
 */
export interface PluginEventDeclaration {
  /** The event's name, unique within the plugin; its kind is `<plugin>:<name>`. */
  readonly name: string;
  /**
   * The event's own version, which an identity records. Without one the plugin's version is used.
   */
  readonly version?: string;
  /** What the event means and when the plugin publishes it. */
  readonly description: string;
  /** The shape of the event's payload: a Zod object whose fields hold no content. */
  readonly payload: z.ZodObject;
}

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
  /** Event kinds the plugin declares, each `<plugin>:<name>`, with the shape of its payload. */
  readonly events?: readonly PluginEventDeclaration[];
  /** Agents defined in code. */
  readonly agents?: readonly PluginAgent[];
  /** Workflows defined in code, registered as `plugin:name` beside the workflow files. */
  readonly workflows?: readonly PluginWorkflow[];
}

/** What `setup` returns, with the hook the host calls once Bureau has started. */
export interface PluginSetupResult<TConfiguration = unknown> extends PluginContributions {
  /**
   * Runs once after Bureau has started, with the host API and the context `setup` received. A
   * rejection marks the plugin failed without stopping the host.
   */
  start?(bureau: PluginHost, context: PluginSetupContext<TConfiguration>): void | Promise<void>;
}
