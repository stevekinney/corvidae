/**
 * The evaluator configuration record (COR-896, "Evaluator configuration
 * record"). A configuration is the unit that gets a stable identity and a
 * version, and a release gate cites it by that identity, so every contract
 * field is required and none is defaulted: an implicit default would let two
 * gates citing "the same" configuration mean different things.
 *
 * Beyond the eleven contract fields, a configuration carries its own `name`
 * and `revision` (the human half of {@link EvaluatorIdentity}) and the
 * `passThreshold` its weighted total must reach, because that threshold
 * changes what a verdict means and so belongs under the digest too.
 */
import type { Effort } from '@lostgradient/operative';
import { z } from 'zod';

/** One problem found while validating a configuration or dataset. */
export interface ConfigurationIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** Thrown when an evaluator configuration, dataset, or scorer binding is rejected. */
export class EvaluatorConfigurationError extends Error {
  override readonly name = 'EvaluatorConfigurationError';
  readonly issues: readonly ConfigurationIssue[];

  constructor(issues: readonly ConfigurationIssue[]) {
    super(
      `Invalid evaluator configuration: ${issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
    this.issues = issues;
  }
}

/** Operative's `Effort` vocabulary, reused so a judge's effort is validated like an agent's. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Effort[];
// Fails to compile if operative adds an effort tier this list does not name.
const EFFORTS_ARE_EXHAUSTIVE: Exclude<Effort, (typeof EFFORTS)[number]> extends never
  ? true
  : never = true;
void EFFORTS_ARE_EXHAUSTIVE;

const identifier = z.string().min(1);
const unitInterval = z.number().min(0).max(1);

const criterionFields = {
  name: identifier,
  description: identifier,
  weight: z.number().positive(),
  hardThreshold: unitInterval.optional(),
};

const criterionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...criterionFields, kind: z.literal('deterministic-assertion') }),
  z.strictObject({ ...criterionFields, kind: z.literal('heuristic') }),
  z.strictObject({
    ...criterionFields,
    kind: z.literal('trajectory'),
    forbiddenTools: z.array(identifier),
    requiredTools: z.array(identifier),
  }),
  z.strictObject({
    ...criterionFields,
    kind: z.literal('policy'),
    referenceMaterialId: identifier,
  }),
  z.strictObject({ ...criterionFields, kind: z.literal('model-judge') }),
]);

const calibrationExampleSchema = z.strictObject({
  id: identifier,
  input: z.string(),
  response: z.string(),
  verdict: z.enum(['pass', 'fail']),
  rationale: identifier,
});

const referenceMaterialEntrySchema = z.strictObject({
  id: identifier,
  title: identifier,
  text: identifier,
});

const judgeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('deterministic'), name: identifier }),
  z.strictObject({ kind: z.literal('heuristic'), name: identifier }),
  z.strictObject({
    kind: z.literal('model'),
    name: identifier,
    model: identifier,
    effort: z.enum(EFFORTS),
    tools: z.array(identifier),
  }),
]);

const budgetSchema = z.strictObject({
  costUsd: z.number().nonnegative(),
  latencyMilliseconds: z.number().int().positive(),
});

/** Adds one issue per entry whose `id`-like key repeats an earlier entry's. */
export function reportDuplicates(
  values: readonly string[],
  path: (index: number) => PropertyKey[],
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: path(index),
        message: `Duplicate ${label} "${value}"`,
      });
    }
    seen.add(value);
  }
}

export const evaluatorConfigurationSchema = z
  .strictObject({
    name: identifier,
    revision: z.number().int().positive(),
    passThreshold: unitInterval,
    criteria: z.array(criterionSchema).min(1),
    examples: z.array(calibrationExampleSchema),
    referenceMaterial: z.strictObject({
      version: identifier,
      entries: z.array(referenceMaterialEntrySchema),
    }),
    judge: judgeSchema,
    promptVersion: identifier,
    datasetVersion: identifier,
    environment: z.strictObject({ name: identifier, revision: identifier }),
    budgets: z.strictObject({ perEvaluation: budgetSchema, perGateRun: budgetSchema }),
    // Every judge declares its trial count; there is no default. A stochastic
    // (model or heuristic) judge with `0` or no repetitions is rejected here.
    repetitions: z.number().int().min(1),
    resultSchemaVersion: z.number().int().positive(),
    codeRevision: z.string().regex(/^[0-9a-f]{7,64}$/, 'Expected a commit hash'),
  })
  .superRefine((configuration, context) => {
    reportDuplicates(
      configuration.criteria.map((criterion) => criterion.name),
      (index) => ['criteria', index, 'name'],
      'criterion name',
      context,
    );
    reportDuplicates(
      configuration.examples.map((example) => example.id),
      (index) => ['examples', index, 'id'],
      'calibration example id',
      context,
    );
    const referenceIds = configuration.referenceMaterial.entries.map((entry) => entry.id);
    reportDuplicates(
      referenceIds,
      (index) => ['referenceMaterial', 'entries', index, 'id'],
      'reference material id',
      context,
    );
    for (const [index, criterion] of configuration.criteria.entries()) {
      if (criterion.kind === 'policy' && !referenceIds.includes(criterion.referenceMaterialId)) {
        context.addIssue({
          code: 'custom',
          path: ['criteria', index, 'referenceMaterialId'],
          message: `Policy criterion cites unknown reference material "${criterion.referenceMaterialId}"`,
        });
      }
      if (criterion.kind === 'model-judge' && configuration.judge.kind !== 'model') {
        context.addIssue({
          code: 'custom',
          path: ['criteria', index, 'kind'],
          message: `A model-judge criterion requires a model judge, not a ${configuration.judge.kind} judge`,
        });
      }
    }
  });

export type EvaluatorConfiguration = z.output<typeof evaluatorConfigurationSchema>;
export type CriterionConfiguration = EvaluatorConfiguration['criteria'][number];
export type CriterionKind = CriterionConfiguration['kind'];
export type CalibrationExample = EvaluatorConfiguration['examples'][number];
export type ReferenceMaterial = EvaluatorConfiguration['referenceMaterial'];
export type ReferenceMaterialEntry = ReferenceMaterial['entries'][number];
export type JudgeConfiguration = EvaluatorConfiguration['judge'];
export type JudgeKind = JudgeConfiguration['kind'];
export type EvaluationBudgets = EvaluatorConfiguration['budgets'];

/** Converts Zod issues to this package's issue shape. */
export function toConfigurationIssues(error: z.ZodError): ConfigurationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

/** Parses an evaluator configuration, throwing {@link EvaluatorConfigurationError} on any issue. */
export function parseEvaluatorConfiguration(input: unknown): EvaluatorConfiguration {
  const parsed = evaluatorConfigurationSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
}
