import type { TokenUsage } from 'conversationalist';

import { DecisionProviderUnavailableError, DecisionSchemaError } from './errors';
import { assertValidDecisionRequest } from './request-validation';
import type {
  DecideOptions,
  Decision,
  DecisionKind,
  DecisionModel,
  DecisionRequest,
} from './types';

/** Options for {@link typesafeJev}. */
export interface TypesafeJevOptions {
  /** The TypeSafe API key. Held in memory only; never logged, stored, or put in an error. */
  readonly apiKey: string;
  /** Replaces the global `fetch` for every request, which tests use to replay recorded responses. */
  readonly fetch?: typeof fetch;
}

/** The slice of `@tanstack/ai` and `@tanstack/ai-typesafe` that {@link typesafeJev} calls. */
export interface TypesafePeers {
  readonly decide: (options: {
    adapter: unknown;
    state: string;
    questions: Record<string, unknown>;
    abortSignal?: AbortSignal;
    debug?: boolean;
  }) => Promise<Record<string, unknown>>;
  readonly boolean: (options: { instructions: string }) => unknown;
  readonly choice: (options: { instructions: string; options: Record<string, string> }) => unknown;
  readonly score: (options: { instructions: string; levels: readonly string[] }) => unknown;
  readonly createTypesafeDecider: (
    model: string,
    apiKey: string,
    config?: { fetch?: typeof fetch },
  ) => unknown;
}

/**
 * How {@link typesafeJev} reaches its optional peers. `resolve` checks
 * synchronously that both are installed, at construction; `load` imports them,
 * on the first `decide`. Tests substitute it to simulate a peer's absence.
 */
export interface TypesafePeerLoader {
  /** Throws when a peer cannot be found. Must not import anything. */
  readonly resolve: () => void;
  /** Imports the peers. Called at most once at a time, and again only after a failure. */
  readonly load: () => Promise<TypesafePeers>;
}

const PROVIDER = 'typesafe';
const JEV_MODEL = 'jev-latest';
const QUESTION_KEY = 'decision';
const STRUCTURED_REFUSAL =
  'typesafeJev serves boolean, choice, and scale requests; route a structured request to llmDecisionModel.';
const KINDS: ReadonlySet<DecisionKind> = new Set(['boolean', 'choice', 'scale']);

/**
 * The real loader: `resolve` looks both peers up without loading them, and
 * `load` imports them, so a package that never asks Jev never executes them.
 */
export const importTypesafePeers: TypesafePeerLoader = {
  resolve: () => {
    import.meta.resolve('@tanstack/ai');
    import.meta.resolve('@tanstack/ai-typesafe');
  },
  load: async () => {
    const [ai, typesafe] = await Promise.all([
      import('@tanstack/ai'),
      import('@tanstack/ai-typesafe'),
    ]);
    return {
      decide: ai.decide as unknown as TypesafePeers['decide'],
      boolean: ai.boolean,
      choice: ai.choice,
      score: ai.score,
      createTypesafeDecider: typesafe.createTypesafeDecider,
    };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function probabilityOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function usageOf(meta: unknown): TokenUsage | undefined {
  const usage = isRecord(meta) ? meta['usage'] : undefined;
  if (!isRecord(usage)) return undefined;
  const { promptTokens, completionTokens, totalTokens } = usage;
  if (
    typeof promptTokens !== 'number' ||
    typeof completionTokens !== 'number' ||
    typeof totalTokens !== 'number'
  ) {
    return undefined;
  }
  return { prompt: promptTokens, completion: completionTokens, total: totalTokens };
}

function question(peers: TypesafePeers, expectation: Expectation): unknown {
  switch (expectation.kind) {
    case 'boolean':
      return peers.boolean({ instructions: expectation.instructions });
    case 'choice':
      return peers.choice({
        instructions: expectation.instructions,
        options: expectation.options,
      });
    case 'scale':
      return peers.score({
        instructions: expectation.instructions,
        levels: expectation.levels,
      });
  }
}

function unusable(reason: string, usage: TokenUsage | undefined): DecisionSchemaError {
  return new DecisionSchemaError({ attempts: 1, usage, validation: reason });
}

/** What a request asks and allows, copied before the first `await` because the caller owns the request. */
type Expectation =
  | { readonly kind: 'boolean'; readonly instructions: string }
  | {
      readonly kind: 'choice';
      readonly instructions: string;
      readonly keys: readonly string[];
      readonly options: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'scale';
      readonly instructions: string;
      readonly levels: readonly string[];
    };

function expectationOf(request: DecisionRequest): Expectation {
  switch (request.kind) {
    case 'boolean':
      return { kind: 'boolean', instructions: request.question };
    case 'choice':
      return {
        kind: 'choice',
        instructions: request.question,
        keys: request.options.map((option) => option.key),
        options: Object.fromEntries(request.options.map((option) => [option.key, option.label])),
      };
    case 'scale':
      return { kind: 'scale', instructions: request.question, levels: [...request.levels] };
    case 'structured':
      throw new TypeError(STRUCTURED_REFUSAL);
  }
}

/** Maps Jev's answer onto the value and probability a {@link Decision} carries. */
function interpret(
  expectation: Expectation,
  answer: unknown,
  usage: TokenUsage | undefined,
): { value: boolean | string | number; probability: number | undefined } {
  if (!isRecord(answer)) throw unusable('Jev returned no usable answer.', usage);
  switch (expectation.kind) {
    case 'boolean': {
      const value = answer['value'];
      const pTrue = probabilityOf(answer['probability']);
      if (typeof value !== 'boolean') throw unusable('Jev returned no yes/no answer.', usage);
      // Jev reports P(true); the decision's probability is the probability of its own value.
      return { value, probability: pTrue === undefined ? undefined : value ? pTrue : 1 - pTrue };
    }
    case 'choice': {
      const value = answer['value'];
      if (typeof value !== 'string' || !expectation.keys.includes(value)) {
        throw unusable('Jev named no option that was offered.', usage);
      }
      return { value, probability: probabilityOf(answer['probability']) };
    }
    case 'scale': {
      const score = answer['score'];
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        throw unusable('Jev returned no score.', usage);
      }
      const lastIndex = expectation.levels.length - 1;
      // The same round-and-clamp the peer uses to pick the nearest level.
      const index = Math.min(Math.max(Math.round(score), 0), lastIndex);
      return { value: index, probability: probabilityOf(answer['probability']) };
    }
  }
}

const PEERS_MESSAGE =
  'typesafeJev needs the optional peers "@tanstack/ai" and "@tanstack/ai-typesafe". Install both to use it.';

/**
 * Builds a Jev {@link DecisionModel} from a loader for the optional peers.
 * {@link typesafeJev} is this with the real imports; it exists so a test can
 * stub the import.
 *
 * @throws {DecisionProviderUnavailableError} When `loader.resolve` throws.
 */
export function createTypesafeJev(
  options: TypesafeJevOptions,
  loader: TypesafePeerLoader,
): DecisionModel {
  // Snapshot: the caller owns `options`, and `decide` reads these after an `await`.
  const { apiKey, fetch: injectedFetch } = options;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('typesafeJev needs a non-empty apiKey.');
  }
  try {
    loader.resolve();
  } catch (cause) {
    throw new DecisionProviderUnavailableError(PROVIDER, PEERS_MESSAGE, { cause });
  }
  // The first `decide` starts the import; concurrent calls share it; a failure is not cached.
  let loaded: Promise<{ peers: TypesafePeers; adapter: unknown }> | undefined;
  const ensureLoaded = (): Promise<{ peers: TypesafePeers; adapter: unknown }> => {
    loaded ??= loader.load().then(
      (peers) => ({
        peers,
        adapter: peers.createTypesafeDecider(
          JEV_MODEL,
          apiKey,
          injectedFetch === undefined ? undefined : { fetch: injectedFetch },
        ),
      }),
      (cause: unknown) => {
        loaded = undefined;
        throw new DecisionProviderUnavailableError(PROVIDER, PEERS_MESSAGE, { cause });
      },
    );
    return loaded;
  };
  return {
    name: `${PROVIDER}/${JEV_MODEL}`,
    kinds: new Set(KINDS),
    async decide(
      request: DecisionRequest,
      decideOptions?: DecideOptions,
    ): Promise<Decision<unknown>> {
      assertValidDecisionRequest(request);
      const expectation = expectationOf(request);
      const state = request.context ?? '';
      const { peers, adapter } = await ensureLoaded();
      const questions = { [QUESTION_KEY]: question(peers, expectation) };
      const result = await peers.decide({
        adapter,
        state,
        questions,
        // The peer logs a failure to the console and then throws it; the caller gets the throw.
        debug: false,
        ...(decideOptions?.signal === undefined ? {} : { abortSignal: decideOptions.signal }),
      });
      const meta = result['meta'];
      const usage = usageOf(meta);
      const { value, probability } = interpret(expectation, result[QUESTION_KEY], usage);
      const model = isRecord(meta) && typeof meta['model'] === 'string' ? meta['model'] : JEV_MODEL;
      return {
        value,
        ...(probability === undefined ? {} : { probability }),
        provider: PROVIDER,
        model,
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}

/**
 * A {@link DecisionModel} backed by TypeSafe's Jev, serving `boolean`,
 * `choice` (Jev's criteria), and `scale` (Jev's levels) requests, and
 * reporting the probability Jev assigns to its answer. It does not serve
 * `structured`; route that to {@link llmDecisionModel}.
 *
 * The peers `@tanstack/ai` and `@tanstack/ai-typesafe` are optional.
 * Construction looks both up without loading them and throws
 * {@link DecisionProviderUnavailableError} when either is missing; the first
 * `decide` imports them. `options.fetch` replaces the global `fetch`.
 *
 * Jev's failures (an HTTP error, a rejected key) reject `decide` with the
 * peer's own error, which carries a numeric `status`; they are not retried.
 */
export function typesafeJev(options: TypesafeJevOptions): DecisionModel {
  return createTypesafeJev(options, importTypesafePeers);
}
