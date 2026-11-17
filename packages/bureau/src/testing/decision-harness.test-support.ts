/**
 * COR-2204 — a `createDecisions` harness with a scripted model, catalog rows and an audit sink and
 * publisher that record what they get, for the decision matrix. No model is live: every model is
 * a double the test scripts.
 */
import {
  type BackendDescriptor,
  type DecisionKind,
  type DecisionModel,
  type DecisionRequest,
} from '@lostgradient/operative';
import { quietFor } from '@lostgradient/testing/wait-until';

import { createDecisions } from '../decisions/create-decisions.ts';
import type { DecisionMadeEvent } from '../events.ts';
import type { BureauModelPolicyOptions } from '../model-policy.ts';

/** Every decision kind. */
export const ALL_KINDS: ReadonlySet<DecisionKind> = new Set<DecisionKind>([
  'boolean',
  'choice',
  'scale',
  'structured',
]);

/** A catalog row that structured output can answer through, available and priced. */
export function catalogRow(
  overrides: Partial<BackendDescriptor> & { provider: string; model: string },
): BackendDescriptor {
  return {
    aliases: [],
    availability: 'available',
    structuredOutput: true,
    pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 1 },
    lifecycle: 'active',
    ...overrides,
  } as unknown as BackendDescriptor;
}

/** The row the language-model fallback uses by default. */
export const FALLBACK_ROW = catalogRow({ provider: 'anthropic', model: 'claude-haiku-5-5' });

/** A decision model that answers `value` and records each call. */
export function scriptedModel(
  value: unknown,
  options: { readonly kinds?: ReadonlySet<DecisionKind>; readonly name?: string } = {},
) {
  const { kinds = ALL_KINDS, name = 'host-model' } = options;
  const calls: { request: DecisionRequest; options: unknown }[] = [];
  const model: DecisionModel = {
    name,
    kinds,
    decide: async (request, decideOptions) => {
      calls.push({ request, options: decideOptions });
      return { value, provider: 'hostprov', model: name };
    },
  };
  return { model, calls };
}

/** A decision model that rejects with `thrown`. */
export function failingModel(thrown: unknown): DecisionModel {
  return {
    name: 'failing',
    kinds: ALL_KINDS,
    decide: async () => {
      throw thrown;
    },
  };
}

/** A decision model that settles when the test releases it, and that rejects when its signal aborts. */
export function heldModel(options: { readonly honorSignal: boolean; readonly value?: unknown }) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: { signal: AbortSignal | undefined }[] = [];
  const model: DecisionModel = {
    name: 'held',
    kinds: ALL_KINDS,
    decide: (_request, decideOptions) => {
      calls.push({ signal: decideOptions?.signal });
      return new Promise((resolve, reject) => {
        const signal = decideOptions?.signal;
        if (options.honorSignal && signal !== undefined) {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }
        void gate.then(() =>
          resolve({ value: options.value ?? true, provider: 'hostprov', model: 'held' }),
        );
      });
    },
  };
  return { model, calls, release };
}

/** The audit record the harness's sink received. */
export interface HarnessAudit {
  readonly runId: unknown;
  readonly type: string;
  readonly detail: Record<string, unknown>;
  readonly principal?: string;
}

/** What {@link decisionHarness} is built from. */
export interface DecisionHarnessOptions {
  readonly models?: Record<string, DecisionModel>;
  readonly model?: string;
  readonly rows?: BackendDescriptor[];
  /** What a `generate` for a row answers; absent means the host supplied no `models.generate`. */
  readonly generate?: (
    row: BackendDescriptor,
  ) => (request: { conversation: unknown }) => Promise<{ content: string }>;
  /** The model a row builds natively; absent means the host supplied no `models.decide`. */
  readonly decideModel?: (row: BackendDescriptor) => DecisionModel;
  readonly audit?: (entry: HarnessAudit) => Promise<void>;
  readonly modelPolicy?: BureauModelPolicyOptions;
}

/** A `createDecisions` composition over doubles, with what it audited and published. */
export function decisionHarness(options: DecisionHarnessOptions = {}) {
  const audits: HarnessAudit[] = [];
  const published: DecisionMadeEvent[] = [];
  const settings: Record<string, unknown> = { 'decisions.model': options.model };
  let rows = options.rows ?? [];
  const generateCalls: string[] = [];
  const composition = createDecisions({
    options: options.models === undefined ? undefined : { models: options.models },
    settings: () => settings,
    ...(options.modelPolicy === undefined ? {} : { modelPolicy: () => options.modelPolicy }),
    models: {
      catalog: () => ({ descriptors: rows }),
      generate: (row: BackendDescriptor) => {
        if (options.generate === undefined) {
          throw Object.assign(new Error('no generate'), { code: 'NOT_CONFIGURED' });
        }
        const inner = options.generate(row);
        return (async (request: { conversation: unknown }) => {
          generateCalls.push(`${row.provider}/${row.model}`);
          const response = await inner(request);
          return { content: response.content, toolCalls: [] };
        }) as never;
      },
      decide: (row: BackendDescriptor) => {
        if (options.decideModel === undefined) {
          throw Object.assign(new Error('no decide'), { code: 'NOT_CONFIGURED' });
        }
        return options.decideModel(row);
      },
    } as never,
    modelsOptions: (options.generate === undefined && options.decideModel === undefined
      ? undefined
      : {
          ...(options.generate === undefined ? {} : { generate: () => undefined }),
          ...(options.decideModel === undefined ? {} : { decide: () => undefined }),
        }) as never,
    notConfigured: (message, cause) =>
      Object.assign(new Error(message, { cause }), { code: 'NOT_CONFIGURED' }),
    badRequest: (message) => {
      throw Object.assign(new Error(message), { code: 'BAD_REQUEST' });
    },
    audit:
      options.audit ??
      (async (entry) => {
        audits.push(entry);
      }),
    published: (event) => published.push(event),
  });
  return {
    decisions: composition.decisions,
    audits,
    /** What each published event names, and nothing it does not. */
    published: () =>
      published.map((event) => ({
        kind: event.kind,
        outcome: event.outcome,
        row: event.row,
        path: event.path,
        taskId: event.taskId,
      })),
    settings,
    setRows: (next: BackendDescriptor[]) => {
      rows = next;
    },
    generateCalls,
  };
}

/** The outcome of a promise as a value, so a test can read a rejection without a `try`. */
export async function settle<T>(
  promise: Promise<T>,
): Promise<{ readonly resolved: T } | { readonly rejected: unknown }> {
  try {
    return { resolved: await promise };
  } catch (error) {
    return { rejected: error };
  }
}

/** Whether `promise` has still not settled once a quiet window has passed. */
export async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await quietFor(25);
  return !settled;
}

/** A matrix row: its number in the outcome matrix, the matrix's source column, and what it asserts. */
export interface MatrixRow {
  readonly row: number;
  readonly source: string;
  readonly title: string;
  readonly run: () => Promise<void> | void;
}
