/**
 * Datasets for the collaboration comparison (COR-818). They are a separate
 * shape from `datasets.ts`'s evaluation datasets because a comparison case
 * says more than an input and an expected answer:
 *
 * - its task class, in COR-820's taxonomy, and the recorded reason it
 *   belongs to that class;
 * - an exact success contract, or a versioned heuristic one whose scorer is
 *   registered under `<name>@<version>`, so task success never depends on a
 *   model judge;
 * - the evidence the task draws on, which of it a correct answer requires,
 *   and who sees what: the direct Agent's view and the shards producers are
 *   assigned round-robin (the ensemble's samples and the collaboration's
 *   producers alike);
 * - the controls it serves, each with its reason: a negative control, where
 *   collaboration should lose to a simpler profile; distributed
 *   information, where no single participant (and so no majority vote over
 *   independent samples) sees every required piece of evidence; and an
 *   ungoverned shared store, where writing to an undeclared store must not
 *   count as coordination.
 *
 * {@link toEvaluationDataset} projects a comparison dataset onto the
 * evaluation dataset an evaluator scores, so the comparison runs through the
 * same evaluator, held-out controls, and trial executor as everything else
 * in this package.
 */
import { sha256Hex } from '@lostgradient/cryptography';
import { z } from 'zod';

import { taskClassSchema } from './collaboration-plan';
import {
  EvaluatorConfigurationError,
  identifier,
  reportDuplicates,
  toConfigurationIssues,
} from './configuration';
import { CASE_VISIBILITIES, type EvaluationDataset } from './datasets';
import { canonicalJson } from './identity';

export const COMPARISON_CONTROLS = [
  'negative-control',
  'distributed-information',
  'ungoverned-shared-state',
] as const;

export type ComparisonControl = (typeof COMPARISON_CONTROLS)[number];

const successContractSchema = z.discriminatedUnion('kind', [
  /** Success is the trimmed final content equalling `expected` exactly. */
  z.strictObject({ kind: z.literal('exact'), expected: z.string().min(1) }),
  /** Success is decided by the deterministic scorer registered as `<name>@<version>`. */
  z.strictObject({
    kind: z.literal('heuristic'),
    name: identifier,
    version: identifier,
    expected: z.string().min(1),
    description: identifier,
  }),
]);

export type SuccessContract = z.output<typeof successContractSchema>;

const comparisonCaseSchema = z.strictObject({
  id: identifier,
  taskClass: taskClassSchema,
  classReason: identifier,
  input: z.string().min(1),
  visibility: z.enum(CASE_VISIBILITIES),
  successContract: successContractSchema,
  evidence: z.array(z.strictObject({ id: identifier, text: identifier })),
  /** The evidence a correct answer cannot do without. */
  requiredEvidence: z.array(identifier),
  views: z.strictObject({
    /** What the one strong direct Agent sees. */
    direct: z.array(identifier),
    /** Assigned to producers round-robin; empty when every producer sees only the input. */
    shards: z.array(z.array(identifier)),
  }),
  controls: z.array(z.strictObject({ kind: z.enum(COMPARISON_CONTROLS), reason: identifier })),
});

export type ComparisonCase = z.output<typeof comparisonCaseSchema>;

function reportUndeclared(
  declared: ReadonlySet<string>,
  ids: readonly string[],
  path: (index: number) => PropertyKey[],
  context: z.RefinementCtx,
): void {
  for (const [index, id] of ids.entries()) {
    if (!declared.has(id)) {
      context.addIssue({
        code: 'custom',
        path: path(index),
        message: `Evidence "${id}" is not declared by this case`,
      });
    }
  }
}

function covers(view: readonly string[], required: readonly string[]): boolean {
  return required.every((id) => view.includes(id));
}

/** A distributed-information case: no single view sees all required evidence, and the shards together do. */
function reportDistribution(
  entry: ComparisonCase,
  declared: ReadonlySet<string>,
  prefix: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const { shards } = entry.views;
  if (shards.length < 2) {
    context.addIssue({
      code: 'custom',
      path: [...prefix, 'views', 'shards'],
      message: 'A distributed-information case splits its evidence across at least two shards',
    });
  }
  // Undeclared ids are reported on their own; judge the distribution of the declared ones.
  const required = entry.requiredEvidence.filter((id) => declared.has(id));
  if (required.length === 0) {
    context.addIssue({
      code: 'custom',
      path: [...prefix, 'requiredEvidence'],
      message: 'A distributed-information case names the evidence a correct answer needs',
    });
    return;
  }
  const solitary = covers(entry.views.direct, required)
    ? 'the direct view'
    : shards.findIndex((shard) => covers(shard, required));
  if (solitary !== -1) {
    const who = typeof solitary === 'string' ? solitary : `shard ${solitary}`;
    context.addIssue({
      code: 'custom',
      path: [...prefix, 'views'],
      message: `A distributed-information case needs every single view to miss some required evidence; ${who} sees all of it`,
    });
  }
  const union = shards.flat();
  const unseen = required.filter((id) => !union.includes(id));
  if (unseen.length > 0) {
    context.addIssue({
      code: 'custom',
      path: [...prefix, 'views', 'shards'],
      message: `The shards together must cover the required evidence; none sees ${unseen.join(', ')}`,
    });
  }
}

function reportCaseIssues(entry: ComparisonCase, index: number, context: z.RefinementCtx): void {
  const prefix = ['cases', index];
  const evidenceIds = entry.evidence.map((item) => item.id);
  reportDuplicates(
    evidenceIds,
    (position) => [...prefix, 'evidence', position, 'id'],
    'evidence id',
    context,
  );
  const declared = new Set(evidenceIds);
  const undeclared = (ids: readonly string[], path: (position: number) => PropertyKey[]): void =>
    reportUndeclared(declared, ids, path, context);
  undeclared(entry.requiredEvidence, (position) => [...prefix, 'requiredEvidence', position]);
  undeclared(entry.views.direct, (position) => [...prefix, 'views', 'direct', position]);
  for (const [shard, ids] of entry.views.shards.entries()) {
    undeclared(ids, (position) => [...prefix, 'views', 'shards', shard, position]);
  }
  reportDuplicates(
    entry.controls.map((control) => control.kind),
    (position) => [...prefix, 'controls', position, 'kind'],
    'control',
    context,
  );
  for (const [position, control] of entry.controls.entries()) {
    if (control.kind === 'distributed-information') {
      reportDistribution(entry, declared, prefix, context);
    }
    if (control.kind === 'ungoverned-shared-state' && entry.taskClass !== 'shared-state') {
      context.addIssue({
        code: 'custom',
        path: [...prefix, 'controls', position, 'kind'],
        message: 'The ungoverned shared-store control belongs to a shared-state case',
      });
    }
  }
}

export const comparisonDatasetSchema = z
  .strictObject({
    id: identifier,
    version: identifier,
    /** The principal who owns the held-out pool, as for an evaluation dataset. */
    owner: identifier,
    cases: z.array(comparisonCaseSchema).min(1),
  })
  .superRefine((dataset, context) => {
    for (const [index, entry] of dataset.cases.entries()) reportCaseIssues(entry, index, context);
    reportDuplicates(
      dataset.cases.map((entry) => entry.id),
      (index) => ['cases', index, 'id'],
      'case id',
      context,
    );
  });

export type ComparisonDataset = z.output<typeof comparisonDatasetSchema>;

/** Parses a comparison dataset, throwing {@link EvaluatorConfigurationError} on any issue. */
export function parseComparisonDataset(input: unknown): ComparisonDataset {
  const parsed = comparisonDatasetSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
}

/** The SHA-256 of the dataset's canonical JSON. */
export function comparisonDatasetDigest(dataset: ComparisonDataset): Promise<string> {
  return sha256Hex(canonicalJson(dataset));
}

/** The evaluation dataset an evaluator scores: each case's input, expected answer, and visibility. */
export function toEvaluationDataset(dataset: ComparisonDataset): EvaluationDataset {
  return {
    id: dataset.id,
    version: dataset.version,
    owner: dataset.owner,
    cases: dataset.cases.map((entry) => ({
      id: entry.id,
      input: entry.input,
      expected: entry.successContract.expected,
      visibility: entry.visibility,
    })),
  };
}

/** The task followed by exactly the evidence `view` names, in the order it names it. */
export function renderParticipantInput(entry: ComparisonCase, view: readonly string[]): string {
  if (view.length === 0) return entry.input;
  const text = new Map(entry.evidence.map((item) => [item.id, item.text]));
  const lines = view.map((id) => `- ${id}: ${text.get(id)}`);
  return `${entry.input}\n\nEvidence:\n${lines.join('\n')}`;
}

/** The evidence producer `index` sees: its round-robin shard, or none when the case has no shards. */
export function shardFor(entry: ComparisonCase, index: number): readonly string[] {
  const { shards } = entry.views;
  return shards.length === 0 ? [] : (shards[index % shards.length] as readonly string[]);
}

/** A deterministic success scorer for a heuristic contract. */
export type SuccessHeuristic = (evidence: {
  readonly content: string;
  readonly expected: string;
}) => boolean;

/** Success heuristics keyed `<name>@<version>`. */
export type SuccessHeuristics = Readonly<Record<string, SuccessHeuristic>>;

/** `exact`, or the `<name>@<version>` key a heuristic contract's scorer is registered under. */
export function successContractKey(contract: SuccessContract): string {
  return contract.kind === 'exact' ? 'exact' : `${contract.name}@${contract.version}`;
}

/**
 * Whether `content` meets `contract`. A heuristic is deterministic code: a
 * missing scorer or a non-boolean answer is a defect in the suite and throws.
 */
export function checkSuccessContract(
  contract: SuccessContract,
  content: string,
  heuristics: SuccessHeuristics,
): boolean {
  if (contract.kind === 'exact') return content.trim() === contract.expected;
  const key = successContractKey(contract);
  const heuristic = heuristics[key];
  if (heuristic === undefined) {
    throw new RangeError(`No success heuristic is registered for "${key}"`);
  }
  const verdict: unknown = heuristic({ content, expected: contract.expected });
  if (typeof verdict !== 'boolean') {
    throw new TypeError(`Success heuristic "${key}" returned ${typeof verdict}, not a boolean`);
  }
  return verdict;
}
