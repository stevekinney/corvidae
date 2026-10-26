import {
  createModelCatalog,
  type BackendDescriptor,
  type GenerateFunction,
  type ModelCatalog,
  type SelectionPlan,
} from '@lostgradient/operative';

import type { AgentDefinitions } from '../agent-catalog';
import {
  createModelPolicyPlanner,
  type BureauModelPolicyOptions,
  type PlanSelectionRequest,
} from '../model-policy';

/**
 * The `models` option of `createBureau`: which model rows the deployment offers, and how a row
 * becomes the `generate` an agent file runs with.
 */
export interface ModelsOptions {
  /**
   * The rows the deployment offers. Defaults to `@lostgradient/operative`'s static seed. Rows a
   * host supplies here are stamped `source: 'operator-override'`, the same stamp
   * {@link Models.replace} gives, so a row's `source` says whether the host chose it.
   */
  readonly catalog?: readonly BackendDescriptor[];
  /**
   * How a catalog row becomes the `generate` an agent file runs with. The host supplies it
   * because the host holds the credentials; Bureau passes the row (provider and model) a file's
   * `model: <provider>/<model>` resolved to. It may throw to say the row cannot be set up, which
   * leaves that file `invalid` with `unknown-model`. Required with `agentSource`.
   */
  readonly generate?: (row: BackendDescriptor) => GenerateFunction;
}

/**
 * Bureau's model namespace, exposed as `Bureau.models`: the catalog the deployment offers, the
 * `generate` for a row, and the plan a request would be given.
 */
export interface Models {
  /**
   * The catalog as it is now. Synchronous and side-effect-free, it returns the identical frozen
   * object until {@link Models.replace} commits a change. `revision` is `1` at boot and Bureau
   * increments it on every `replace`; `stale` is always `false`; `generatedAt` is the runtime
   * clock's time at the commit.
   */
  catalog(): ModelCatalog;
  /**
   * Replaces every row and returns the new catalog. Rows are stamped
   * `source: 'operator-override'`, the revision increments, and agent files are validated again
   * against the new rows.
   */
  replace(rows: readonly BackendDescriptor[]): ModelCatalog;
  /**
   * The `generate` for a catalog row, from {@link ModelsOptions.generate}. Throws what that
   * function throws, and throws `NOT_CONFIGURED` when the host supplied none.
   */
  generate(row: BackendDescriptor): GenerateFunction;
  /**
   * Builds the full `SelectionPlan` a request would be given against the current catalog and
   * `modelPolicy`. Synchronous and side-effect-free: it starts no run and dispatches no event.
   */
  plan(request: PlanSelectionRequest): SelectionPlan;
}

/** What {@link createModels} reads from the Bureau that is constructing it. */
export interface ModelsDependencies<D extends AgentDefinitions> {
  readonly options: ModelsOptions | undefined;
  /** The only clock this module reads: stamps `generatedAt` on the boot catalog and on `replace`. */
  readonly now: () => string;
  /** Builds the error `generate` throws when the host supplied no `generate`. */
  readonly notConfigured: () => Error;
  /** Refuses malformed input, as `BAD_REQUEST`. */
  readonly badRequest: (message: string) => never;
  /** Called after a `replace` commits, so agent files are validated against the new rows. */
  readonly onReplace: () => void;
  readonly agents: D;
  readonly modelPolicy: BureauModelPolicyOptions | undefined;
}

/**
 * Recursively clones an object graph and freezes the clone at every level, so a caller keeps its
 * own rows mutable and the catalog never changes under a reader.
 */
function deepCloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item: unknown) => deepCloneAndFreeze(item))) as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = deepCloneAndFreeze(nested);
  }
  return Object.freeze(clone) as T;
}

function stamp(rows: readonly BackendDescriptor[]): readonly BackendDescriptor[] {
  return Object.freeze(
    rows.map((row) => deepCloneAndFreeze({ ...row, source: 'operator-override' as const })),
  );
}

/** Checks `rows` before anything reads them: an array of rows that each name a provider and a model. */
function validateRows(
  rows: unknown,
  label: string,
  badRequest: (message: string) => never,
): asserts rows is readonly BackendDescriptor[] {
  if (!Array.isArray(rows)) badRequest(`${label} must be an array of catalog rows`);
  for (const row of rows as readonly unknown[]) {
    const candidate = row as Partial<BackendDescriptor> | null;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof candidate.provider !== 'string' ||
      typeof candidate.model !== 'string'
    ) {
      badRequest(`${label} must hold only rows that name a "provider" and a "model"`);
    }
  }
}

/**
 * Refuses a malformed `models` option, as `BAD_REQUEST`, before `createBureau` opens anything.
 * The caller owns `options`, so nothing here keeps a reference to it.
 */
export function validateModelsOptions(
  options: unknown,
  badRequest: (message: string) => never,
): asserts options is ModelsOptions | undefined {
  if (options === undefined) return;
  if (typeof options !== 'object' || options === null) {
    badRequest('"options.models" must be an object');
  }
  const { catalog, generate } = options as { catalog?: unknown; generate?: unknown };
  if (catalog !== undefined) validateRows(catalog, '"options.models.catalog"', badRequest);
  if (generate !== undefined && typeof generate !== 'function') {
    badRequest('"options.models.generate" must be a function');
  }
}

/** Builds Bureau's model namespace. */
export function createModels<D extends AgentDefinitions>(
  dependencies: ModelsDependencies<D>,
): Models {
  const { options, now } = dependencies;
  const supplied = options?.catalog;
  let catalog: ModelCatalog = Object.freeze({
    revision: 1,
    descriptors:
      supplied === undefined
        ? deepCloneAndFreeze(createModelCatalog().descriptors)
        : stamp(supplied),
    generatedAt: now(),
    stale: false,
    projection: 'privileged' as const,
  });
  const generateFor = options?.generate;
  const planner = createModelPolicyPlanner({
    agents: dependencies.agents,
    models: { catalog: () => catalog },
    ...(dependencies.modelPolicy === undefined ? {} : { modelPolicy: dependencies.modelPolicy }),
  });
  const models: Models = {
    catalog: () => catalog,
    replace(rows) {
      validateRows(rows, '"rows"', dependencies.badRequest);
      catalog = Object.freeze({
        revision: catalog.revision + 1,
        descriptors: stamp(rows),
        generatedAt: now(),
        stale: false,
        projection: 'privileged' as const,
      });
      dependencies.onReplace();
      return catalog;
    },
    generate(row) {
      if (generateFor === undefined) throw dependencies.notConfigured();
      return generateFor(row);
    },
    plan: (request) => planner.plan(request),
  };
  return Object.freeze(models);
}
