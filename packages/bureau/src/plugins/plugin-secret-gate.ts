/**
 * COR-1879 — a plugin's declared secrets as availability, and the contributions that wait on them.
 *
 * A plugin whose declared secret is not set still loads: its `setup` runs, and every contribution
 * it returns is registered at construction, because the options that receive them
 * (`contributionCatalog` above all) are read once. While a declared secret is missing the plugin is
 * `needs-setup`, with one `secret-missing` problem per missing key naming every contribution it
 * registered, since a declaration does not say which of them use which secret. Each contribution's
 * callable is gated instead of withheld: it refuses with {@link PluginNeedsSetupError} until every
 * declared secret is set. The gate re-reads a key whenever the host's `watch` reports it saved or
 * removed, so a saved secret makes the contributions available, and a removed one makes them
 * refuse again, with no restart. Only presence is kept, never a value.
 *
 * Outcome matrix, for a plugin with one declared secret. "Refuses" means the callable rejects (or,
 * for a synchronous one, throws) {@link PluginNeedsSetupError}; "works" means it calls through.
 * The second column is the secret missing at startup, the third after `watch` reports it saved, the
 * fourth after `watch` reports it removed again.
 *
 * | Contribution | Missing | Saved | Removed again |
 * | -- | -- | -- | -- |
 * | tool (`execute`) | refuses; the call fails, after any approval | works | refuses |
 * | activity (`execute`, `verify`, `compensate`) | refuses without retrying (`nonRetryableErrors`); a refused `verify` fails the result, and a refused `compensate` is a failed compensation | works | refuses |
 * | trigger kind (`start`) | waits: the real `start` is not called | the real `start` runs | the trigger it started is stopped and waits again |
 * | validator (`validate`) | refuses; the goal's attempt fails | works | refuses |
 * | guardrail, `input`, `output` and `tools` (`detect`, `validate`) | refuses; a run contains the refusal as it contains any detector's or validator's error, so the guardrail finds nothing and the input, reply or call it would judge goes on (COR-2104) | works | refuses |
 * | guardrail factory, `input`, `output` and `tools` (`create`, then the guardrail's `detect` or `validate`) | `create` is not gated: an agent that configures it stays valid and builds, and the guardrail it builds refuses as a guardrail does, so a run contains the refusal and goes on (COR-2118) | works | refuses |
 * | interceptor, a point Operative runs through its hook registry (`prepareStep`, `beforeToolExecution`, `afterToolExecution`, `onStep`, `selectTools`, `validateResponse`, `validateToolResult`, the compaction points, `selectToolChoice`, `beforeGenerate`, `afterGenerate`, `onRunStart`) | refuses; the step or the run fails with the refusal, so an agent file that lists the interceptor cannot run | works | refuses |
 * | interceptor, an observing point (`onLLMInput`, `onLLMOutput`, `onRunComplete`, `onRunError`, `onRunAbort`) | refuses; Operative settles these handlers and discards a failure, so the run's own outcome and error stand and the plugin's handler does not run | works | refuses |
 * | interceptor, `onError` | refuses; Operative catches a failing recovery hook and the original error propagates, so the handler does not run. One `try` wraps the loop over the recovery handlers, so the refusal also skips every lower-priority `onError` handler of the run, whatever any `onError` option says | works | refuses |
 * | interceptor with `appliesTo: 'every-agent'`, every point (COR-2127) | refuses, as any interceptor does; for an agent that lists it, the step or the run fails as above. The plugin tier every other agent's run holds turns the refusal into `undefined` without running the handler (`run-hook-tiers.ts`), which every point reads as "no answer", so those runs go on as if the set were absent | works | refuses for an agent that lists it, skipped for every other |
 * | decision router (`decide`) | refuses | works | refuses |
 * | hook action kind (`run`) | refuses; the delivery fails and is retried by the hook's policy | works | refuses |
 * | embedder (`embed`, `availability`) | refuses; `availability` is `needs-setup` | works; `available` | refuses; `needs-setup` |
 * | memory guardrail, `guardrails.memory` (`detect`) | not run: it answers that it detected nothing (`triggered: false`, category `plugin-needs-setup`), so memory's other detectors decide | works | not run |
 * | scorer (`evaluate`) | refuses; the sample is not scored | works | refuses |
 * | event formatter (`format`) | refuses; the event gets the default title | works | refuses |
 * | code agent (`run`, `OPERATIVE_RESOLVE_RUN_OPTIONS`) | throws or rejects; `bureau.tasks.start` rejects and the run is not started, and a recovered or claimed durable run fails to resolve | works | throws or rejects |
 * | provider, panel | not gated: Bureau hands a provider to the host's `models.catalog` factory and has no entry point for a panel, which the host serves as a static page from `bureau.plugins.panels()`, and the host reads the plugin's status and its secret (COR-1880, COR-1884) | | |
 *
 * An interceptor's hook written as `{ handler, replay, onError, priority }` is gated as the bare
 * function is: its `handler` refuses, and the fields beside it are kept, so a plugin's own
 * `onError: () => 'continue'` also swallows the refusal. The handler does not run either way.
 *
 * `afterStart` runs whether or not a secret is missing: the plugin loaded, and the host API it
 * receives needs no secret.
 *
 * @module plugin-secret-gate
 */

import {
  isGuardrailFactory,
  type PluginContributions,
  type PluginGuardrailFactory,
  type PluginInterceptor,
  type PluginTrigger,
} from '@lostgradient/interborough-plugin';
import {
  type GuardrailEntry,
  guardrailOf,
  type InputDetector,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type OutputValidator,
  type ToolCallValidator,
} from '@lostgradient/operative';
import type { DetectionResult, DetectorContext } from 'armorer';

import { INTERCEPTOR_POINTS } from '../agent-contributions';
import type { BureauPluginSecrets } from './plugin-types';

/**
 * The `category` of the result a gated memory guardrail answers with while its plugin needs setup:
 * it did not run, and detected nothing.
 */
export const PLUGIN_NEEDS_SETUP_CATEGORY = 'plugin-needs-setup';

/**
 * `entry` with its guardrail replaced by `wrap`'s, keeping the action it carries (COR-2104).
 */
function withGuardrail<T, A extends string>(
  entry: GuardrailEntry<T, A>,
  wrap: (guardrail: T) => T,
): GuardrailEntry<T, A> {
  const guardrail = guardrailOf(entry);
  return guardrail === entry
    ? wrap(guardrail)
    : { ...(entry as object), guardrail: wrap(guardrail) };
}

/**
 * `guardrail` with `wrap` applied: to the guardrail itself, or, for a factory (COR-2118), to every
 * guardrail its `create` builds, so `create` itself runs ungated and only what it built refuses.
 */
function gatedFactoryOr<T, G extends T | PluginGuardrailFactory<T>>(
  guardrail: G,
  wrap: (built: T) => T,
): G {
  if (!isGuardrailFactory<T>(guardrail)) return wrap(guardrail as T) as G;
  const factory: PluginGuardrailFactory<T> = guardrail;
  return {
    ...factory,
    create: (configuration: unknown) => wrap(factory.create(configuration)),
  } as G;
}

/** A plugin's contribution was called while a secret its plugin declared is not set. */
export class PluginNeedsSetupError extends Error {
  /** The plugin that needs setup. */
  readonly plugin: string;
  /** The contribution that was called, as `plugin:name`. */
  readonly contribution: string;
  /** The declared secret keys that are not set. */
  readonly keys: readonly string[];

  /** The error for a call to `contribution` of `plugin` while `keys` are not set. */
  constructor(plugin: string, contribution: string, keys: readonly string[]) {
    super(
      `"${contribution}" is not available: plugin "${plugin}" needs setup, because ${keys
        .map((key) => `the secret "${key}"`)
        .join(' and ')} ${keys.length === 1 ? 'is' : 'are'} not set.`,
    );
    this.name = 'PluginNeedsSetupError';
    this.plugin = plugin;
    this.contribution = contribution;
    this.keys = keys;
  }
}

/** Whether every secret one plugin declared is set, kept current by the host's `watch`. */
export interface PluginSecretGate {
  /** The plugin. */
  readonly plugin: string;
  /** The declared keys that are not set now, in declaration order. */
  missing(): readonly string[];
  /** Whether every declared key is set. */
  available(): boolean;
  /** Throws {@link PluginNeedsSetupError} for `contribution` unless every declared key is set. */
  assertAvailable(contribution: string): void;
  /** Calls `listener` after the set of missing keys changes; returns the function that stops it. */
  onChange(listener: () => void): () => void;
  /**
   * Starts following the host's `watch` for each declared key, and reads each key again at once,
   * so a secret saved between composition's read and the subscription is not missed. Returns the
   * function that stops following and drops every `onChange` listener.
   */
  watch(): () => void;
}

function isSet(value: string | undefined): boolean {
  return typeof value === 'string' && value !== '';
}

/**
 * The gate of `plugin` over `keys`, read once now. A key whose read fails counts as missing, so a
 * reader that cannot answer leaves the plugin `needs-setup` rather than its contributions
 * calling through without the secret.
 */
export async function createPluginSecretGate(
  plugin: string,
  keys: readonly string[],
  secrets: BureauPluginSecrets | undefined,
): Promise<PluginSecretGate> {
  const missing = new Set<string>();
  const read = async (key: string): Promise<boolean> => {
    if (secrets === undefined) return false;
    try {
      return isSet(await secrets.get(key));
    } catch {
      return false;
    }
  };
  for (const key of keys) {
    if (!(await read(key))) missing.add(key);
  }
  const listeners = new Set<() => void>();
  // Each read of a key takes a generation; only the latest read of that key may apply, so a
  // save followed at once by a removal never ends with the save's slower read winning.
  const generations = new Map<string, number>();
  let stopped = false;

  const apply = (key: string, present: boolean): void => {
    if (present === !missing.has(key)) return;
    if (present) missing.delete(key);
    else missing.add(key);
    for (const listener of listeners) listener();
  };

  const recheck = async (key: string): Promise<void> => {
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    const present = await read(key);
    if (stopped || generations.get(key) !== generation) return;
    apply(key, present);
  };

  const missingNow = (): readonly string[] => keys.filter((key) => missing.has(key));

  return {
    plugin,
    missing: missingNow,
    available: () => missing.size === 0,
    assertAvailable(contribution) {
      if (missing.size > 0) throw new PluginNeedsSetupError(plugin, contribution, missingNow());
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    watch() {
      if (secrets === undefined || keys.length === 0) return () => undefined;
      const stops = keys.map((key) => secrets.watch(key, () => void recheck(key)));
      for (const key of keys) void recheck(key);
      return () => {
        stopped = true;
        listeners.clear();
        for (const stop of stops) stop();
      };
    },
  };
}

/** `fn`, refusing through `gate` for `contribution` before it is called. */
function gated<A extends unknown[], R>(
  gate: PluginSecretGate,
  contribution: string,
  fn: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args) => {
    gate.assertAvailable(contribution);
    return fn(...args);
  };
}

function gatedInterceptor(
  gate: PluginSecretGate,
  contribution: string,
  interceptor: PluginInterceptor,
): PluginInterceptor {
  const gatedPoints: Record<string, unknown> = {};
  for (const point of INTERCEPTOR_POINTS) {
    const hook = interceptor[point];
    if (hook === undefined) continue;
    // Either written form: a function, or `{ handler, replay, onError, priority }`, whose handler
    // is gated and whose other fields are kept, so the gate does not change how the hook sorts,
    // replays or handles an error.
    const gatedHandler = (handler: (...args: never[]) => unknown) =>
      gated(gate, contribution, (handler as (...args: unknown[]) => unknown).bind(interceptor));
    gatedPoints[point] =
      typeof hook === 'function'
        ? gatedHandler(hook)
        : { ...hook, handler: gatedHandler(hook.handler) };
  }
  // Each point's gated handler keeps the signature of the one it wraps.
  return { ...interceptor, ...gatedPoints };
}

/**
 * A trigger kind whose `start` waits for the gate: the kind's own `start` runs once every declared
 * secret is set, the trigger it started is stopped when one is removed, and it starts again when
 * the secret is saved again. The returned stop stops whichever is running and follows the gate no
 * more. Every transition runs in order on one chain, so a start and a stop never overlap.
 */
function gatedTriggerKind(gate: PluginSecretGate, kind: PluginTrigger): PluginTrigger {
  return {
    ...kind,
    start: async (context) => {
      let stopInner: (() => void | Promise<void>) | undefined;
      let ended = false;
      let chain: Promise<void> = Promise.resolve();
      const settle = async (): Promise<void> => {
        const want = !ended && gate.available() && !context.signal.aborted;
        if (want && stopInner === undefined) {
          stopInner = await kind.start(context);
        } else if (!want && stopInner !== undefined) {
          const stop = stopInner;
          stopInner = undefined;
          await stop();
        }
      };
      const queue = (): Promise<void> => {
        const next = chain.then(settle);
        // A later transition runs whatever this one did; its failure is the kind's to report
        // through the first `start`, and a later one leaves the trigger stopped until the next.
        chain = next.catch(() => undefined);
        return next;
      };
      const unsubscribe = gate.onChange(() => void queue());
      try {
        await queue();
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return async () => {
        ended = true;
        unsubscribe();
        await queue();
      };
    },
  };
}

/**
 * `result` with every contribution's callable gated by `gate` (tools excepted: `pluginTool`
 * gates them as it rebuilds them). Identity, names and every other field are kept.
 */
export function gatedContributions<T extends PluginContributions>(
  result: T,
  gate: PluginSecretGate,
  idOf: (name: string) => string,
): T {
  const guardrails = result.guardrails;
  return {
    ...result,
    ...(result.activities === undefined
      ? {}
      : {
          activities: result.activities.map((activity) => {
            const id = idOf(activity.name);
            const { verify, compensate } = activity;
            return {
              ...activity,
              execute: gated(gate, id, activity.execute.bind(activity)),
              // `verify` and `compensate` run the plugin's code as `execute` does, so they refuse
              // with it; `resourceScope` and `idempotencyKey` only derive keys and stay ungated.
              ...(verify === undefined
                ? {}
                : {
                    // Either verifier shape: the wrapper passes every argument through.
                    verify: gated(
                      gate,
                      id,
                      (verify as (...args: unknown[]) => unknown).bind(activity),
                    ) as typeof verify,
                  }),
              ...(compensate === undefined
                ? {}
                : { compensate: gated(gate, id, compensate.bind(activity)) }),
              ...(activity.retry === undefined
                ? {}
                : {
                    retry: {
                      ...activity.retry,
                      // A refusal for a missing secret is not a fault a retry can clear.
                      nonRetryableErrors: [
                        ...(activity.retry.nonRetryableErrors ?? []),
                        'PluginNeedsSetupError',
                      ],
                    },
                  }),
            };
          }),
        }),
    ...(result.triggers === undefined
      ? {}
      : {
          triggers: result.triggers.map((kind) => gatedTriggerKind(gate, kind)),
        }),
    ...(result.validators === undefined
      ? {}
      : {
          validators: result.validators.map((validator) => ({
            ...validator,
            identity: validator.identity,
            validate: gated(
              gate,
              idOf(validator.identity.name),
              validator.validate.bind(validator),
            ),
          })),
        }),
    ...(guardrails === undefined
      ? {}
      : {
          guardrails: {
            ...(guardrails.input === undefined
              ? {}
              : {
                  input: guardrails.input.map((entry) =>
                    withGuardrail(entry, (detector) =>
                      gatedFactoryOr(detector, (built: InputDetector) => ({
                        ...built,
                        detect: gated(gate, idOf(detector.name), built.detect.bind(built)),
                      })),
                    ),
                  ),
                }),
            ...(guardrails.output === undefined
              ? {}
              : {
                  output: guardrails.output.map((entry) =>
                    withGuardrail(entry, (validator) =>
                      gatedFactoryOr(validator, (built: OutputValidator) => ({
                        ...built,
                        validate: gated(gate, idOf(validator.name), built.validate.bind(built)),
                      })),
                    ),
                  ),
                }),
            ...(guardrails.tools === undefined
              ? {}
              : {
                  // The validator's own `action` is kept by the spread.
                  tools: guardrails.tools.map((validator) =>
                    gatedFactoryOr(validator, (built: ToolCallValidator) => ({
                      ...built,
                      validate: gated(gate, idOf(validator.name), built.validate.bind(built)),
                    })),
                  ),
                }),
            ...(guardrails.memory === undefined
              ? {}
              : {
                  memory: guardrails.memory.map((detector) => ({
                    ...detector,
                    detect: async (
                      input: string,
                      context: DetectorContext,
                    ): Promise<DetectionResult> => {
                      // Not run: memory counts a detector's failure as a detection, so a refusal here
                      // would hold back every write and recall while the plugin needs setup.
                      if (!gate.available()) {
                        return {
                          triggered: false,
                          confidence: 0,
                          category: PLUGIN_NEEDS_SETUP_CATEGORY,
                          detail: new PluginNeedsSetupError(
                            gate.plugin,
                            idOf(detector.name),
                            gate.missing(),
                          ).message,
                        };
                      }
                      return detector.detect(input, context);
                    },
                  })),
                }),
          },
        }),
    ...(result.interceptors === undefined
      ? {}
      : {
          interceptors: result.interceptors.map((interceptor) =>
            gatedInterceptor(gate, idOf(interceptor.name), interceptor),
          ),
        }),
    ...(result.decisionRouters === undefined
      ? {}
      : {
          decisionRouters: result.decisionRouters.map((model) => ({
            name: model.name,
            kinds: model.kinds,
            decide: gated(gate, idOf(model.name), model.decide.bind(model)),
          })),
        }),
    ...(result.reactions === undefined
      ? {}
      : {
          reactions: result.reactions.map((kind) => ({
            ...kind,
            run: gated(gate, idOf(kind.name), kind.run.bind(kind)),
          })),
        }),
    ...(result.embedders === undefined
      ? {}
      : {
          embedders: result.embedders.map((embedder) => ({
            ...embedder,
            embed: gated(gate, idOf(embedder.name), embedder.embed),
          })),
        }),
    ...(result.scorers === undefined
      ? {}
      : {
          scorers: result.scorers.map((judge) => ({
            ...judge,
            evaluate: gated(gate, idOf(judge.name), judge.evaluate.bind(judge)),
          })),
        }),
    ...(result.formatters === undefined
      ? {}
      : {
          formatters: result.formatters.map((formatter) => ({
            ...formatter,
            format: (event: Parameters<typeof formatter.format>[0]) => {
              gate.assertAvailable(idOf(formatter.name));
              return formatter.format(event);
            },
          })),
        }),
    ...(result.agents === undefined
      ? {}
      : {
          agents: result.agents.map(({ name, agent }) => ({
            name,
            agent: gatedAgent(gate, idOf(name), agent),
          })),
        }),
  };
}

/**
 * `agent` with every member that starts work refusing while the gate is closed: `run`, and the
 * definition resolver (`OPERATIVE_RESOLVE_RUN_OPTIONS`) through which Bureau starts a durable run,
 * recovers one, and claims a run another execution created. The resolver stays a function exactly
 * when the agent has one, so a durable dispatch is still durable and its refusal reaches the
 * caller. A proxy, so every other member (including the other symbol-keyed ones Operative reads)
 * is the agent's own, read with the agent as `this`.
 */
function gatedAgent<A extends object & { run: (...args: never[]) => unknown }>(
  gate: PluginSecretGate,
  contribution: string,
  agent: A,
): A {
  const startsWork = new Set<PropertyKey>(['run', OPERATIVE_RESOLVE_RUN_OPTIONS]);
  const gatedMembers = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy(agent, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!startsWork.has(property)) return (value as () => unknown).bind(target);
      let member = gatedMembers.get(property);
      if (member === undefined) {
        member = (...args: unknown[]) => {
          gate.assertAvailable(contribution);
          return (Reflect.get(target, property, target) as (...args: unknown[]) => unknown).apply(
            target,
            args,
          );
        };
        gatedMembers.set(property, member);
      }
      return member;
    },
  });
}
