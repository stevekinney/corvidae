/**
 * The memory-lifecycle scenario vocabulary and its schema (COR-755). A
 * scenario is plain data: a timeline of observations, deletion requests, and
 * restarts that the harness replays against a memory baseline, then one
 * named action task whose outcome the deterministic environment checks.
 *
 * The ground truth a scorer needs is declared or derived here, never inferred
 * from what a baseline did:
 *
 * - Every observation is labeled `relevant`, `distractor`, or `poison`.
 *   Relevant and distractor evidence should be admitted; poison should not.
 * - Evidence of a `co-user` or `other-tenant` principal is foreign to the
 *   owner: it must never reach the owner's context or action.
 * - A deletion request reaches the evidence it names and every derived view
 *   of it, transitively (COR-806: deleting a source reaches its projections).
 * - `expected.staleEvidence` names superseded evidence that must not be
 *   presented once its successor exists.
 */
import { z } from 'zod';

import { type ConfigurationIssue, identifier, reportDuplicates } from '../configuration';

/** The lifecycle stages a scenario exercises. */
export const LIFECYCLE_STAGES = [
  'writing',
  'state-maintenance',
  'retrieval',
  'downstream-use',
  'governance',
  'final-action',
] as const;

/** The conditions a scenario puts the memory under. */
export const SCENARIO_CONDITIONS = [
  'temporal-change',
  'contradiction',
  'long-delay',
  'procedural-reuse',
  'multimodal-evidence',
  'recovery',
  'deletion',
  'privacy',
  'poisoning',
] as const;

/** The memory kind a scenario's task depends on; the report groups benefit by it. */
export const MEMORY_WORKLOADS = [
  'preference',
  'identity',
  'semantic-state',
  'procedure',
  'resource',
] as const;

/**
 * Who an observation belongs to. `owner` is the user the task acts for;
 * `operator` is a human support operator writing verified records for the
 * owner; `co-user` shares the owner's tenant and agent but not their data;
 * `other-tenant` belongs to another tenant entirely.
 */
export const SCENARIO_PRINCIPALS = ['owner', 'operator', 'co-user', 'other-tenant'] as const;

/** Where an observation's content came from. */
export const EVIDENCE_SOURCES = [
  'conversation',
  'tool-result',
  'ingested-document',
  'operator',
] as const;

/**
 * What an observation is. A `derived-view` (a caption, OCR text, or
 * transcript) is produced from an earlier `asset` it names in `derivedFrom`.
 */
export const EVIDENCE_KINDS = ['fact', 'procedure', 'asset', 'derived-view'] as const;
export const EVIDENCE_MODALITIES = ['text', 'image', 'audio'] as const;
export const EVIDENCE_LABELS = ['relevant', 'distractor', 'poison'] as const;

/** The external benchmarks this suite draws scenario ideas and reporting dimensions from. */
export const BENCHMARK_SOURCES = [
  'MemoryArena',
  'WorldMemArena',
  'MemoryAgentBench',
  'HaluMem',
  'LongMemEval-V2',
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
export type ScenarioCondition = (typeof SCENARIO_CONDITIONS)[number];
export type MemoryWorkload = (typeof MEMORY_WORKLOADS)[number];
export type ScenarioPrincipal = (typeof SCENARIO_PRINCIPALS)[number];
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type BenchmarkSource = (typeof BENCHMARK_SOURCES)[number];

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Expected a lowercase slug');
const instant = z.iso.datetime({ offset: true });

const evidenceSchema = z.strictObject({
  id: slug,
  principal: z.enum(SCENARIO_PRINCIPALS),
  source: z.enum(EVIDENCE_SOURCES),
  kind: z.enum(EVIDENCE_KINDS),
  modality: z.enum(EVIDENCE_MODALITIES),
  label: z.enum(EVIDENCE_LABELS),
  content: z.string().trim().min(1),
  /** The asset a derived view was produced from. Required for, and only for, a derived view. */
  derivedFrom: slug.optional(),
});

const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('observe'), at: instant, evidence: evidenceSchema }),
  /** The owner asks for evidence to be deleted. */
  z.strictObject({ kind: z.literal('forget'), at: instant, evidenceId: slug }),
  /** The process restarts: in-process state is lost, durable storage survives. */
  z.strictObject({ kind: z.literal('restart'), at: instant }),
]);

const taskSchema = z.strictObject({
  /** The named action task; the release gate's improvement is measured over these. */
  name: slug,
  /** What the owner asks for. */
  instruction: identifier,
  /** What to look up in memory. */
  query: identifier,
  /** The statement slot the action needs, as evidence states it. */
  slot: identifier,
  /** The environment action that completes the task. */
  action: z.string().regex(/^[a-z][a-z_]{0,63}$/, 'Expected a snake_case action name'),
});

const expectedSchema = z.strictObject({
  /** The environment state a correct run leaves: an action with a value, or a reported unknown. */
  outcome: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('act'), value: identifier }),
    z.strictObject({ kind: z.literal('unknown') }),
  ]),
  /** Evidence the context must hold for the task to be decidable. */
  requiredEvidence: z.array(slug),
  /** Superseded evidence that must not be presented once its successor exists. */
  staleEvidence: z.array(slug),
});

const sourceSchema = z.strictObject({
  benchmark: z.enum(BENCHMARK_SOURCES),
  /** The scenario idea or reporting dimension adopted, in this suite's words. */
  idea: identifier,
});

const scenarioShape = z.strictObject({
  id: slug,
  title: identifier,
  workload: z.enum(MEMORY_WORKLOADS),
  conditions: z.array(z.enum(SCENARIO_CONDITIONS)).min(1),
  stages: z.array(z.enum(LIFECYCLE_STAGES)).min(1),
  timeline: z.array(eventSchema).min(1),
  task: taskSchema,
  expected: expectedSchema,
  /** External ideas this scenario adopted; empty when it comes from this repository's own requirements. */
  sources: z.array(sourceSchema),
});

export const memoryScenarioSchema = scenarioShape.superRefine((scenario, context) => {
  for (const issue of scenarioIssues(scenario)) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
});

export const memoryScenarioSuiteSchema = z
  .strictObject({
    id: identifier,
    version: identifier,
    /** The principal who owns the suite's held-out scenarios. */
    owner: identifier,
    scenarios: z.array(memoryScenarioSchema).min(1),
  })
  .superRefine((suite, context) => {
    reportDuplicates(
      suite.scenarios.map((scenario) => scenario.id),
      (index) => ['scenarios', index, 'id'],
      'scenario id',
      context,
    );
  });

export type ScenarioEvidence = z.output<typeof evidenceSchema>;
export type ScenarioEvent = z.output<typeof eventSchema>;
export type ScenarioTask = z.output<typeof taskSchema>;
export type ExpectedOutcome = z.output<typeof expectedSchema>['outcome'];
export type MemoryScenario = z.output<typeof memoryScenarioSchema>;
export type MemoryScenarioSuite = z.output<typeof memoryScenarioSuiteSchema>;

/** Every observed piece of evidence, in timeline order. */
export function scenarioEvidence(scenario: Pick<MemoryScenario, 'timeline'>): ScenarioEvidence[] {
  return scenario.timeline.flatMap((event) => (event.kind === 'observe' ? [event.evidence] : []));
}

function referenceIssues(
  ids: readonly string[],
  known: ReadonlySet<string>,
  path: (index: number) => PropertyKey[],
  label: string,
): ConfigurationIssue[] {
  return ids.flatMap((id, index) =>
    known.has(id) ? [] : [{ path: path(index), message: `Unknown ${label} evidence "${id}"` }],
  );
}

/** Timeline and reference problems a schema alone cannot see. */
function scenarioIssues(scenario: z.output<typeof scenarioShape>): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const seen = new Map<string, ScenarioEvidence>();
  let previous = Number.NEGATIVE_INFINITY;
  for (const [index, event] of scenario.timeline.entries()) {
    const at = Date.parse(event.at);
    if (at < previous) {
      issues.push({ path: ['timeline', index, 'at'], message: 'Events must be in time order' });
    }
    previous = at;
    if (event.kind === 'forget' && !seen.has(event.evidenceId)) {
      issues.push({
        path: ['timeline', index, 'evidenceId'],
        message: `A deletion must follow the evidence it names ("${event.evidenceId}")`,
      });
    }
    if (event.kind !== 'observe') continue;
    const { evidence } = event;
    if (seen.has(evidence.id)) {
      issues.push({
        path: ['timeline', index, 'evidence', 'id'],
        message: `Duplicate evidence id "${evidence.id}"`,
      });
    }
    // Scorers find recalled evidence by its exact content, so content is unique too.
    if ([...seen.values()].some((earlier) => earlier.content === evidence.content)) {
      issues.push({
        path: ['timeline', index, 'evidence', 'content'],
        message: 'Evidence content must be unique within a scenario',
      });
    }
    const derived = evidence.kind === 'derived-view';
    if (derived !== (evidence.derivedFrom !== undefined)) {
      issues.push({
        path: ['timeline', index, 'evidence', 'derivedFrom'],
        message: 'A derived view, and only a derived view, names the asset it came from',
      });
    } else if (derived && seen.get(evidence.derivedFrom!)?.kind !== 'asset') {
      issues.push({
        path: ['timeline', index, 'evidence', 'derivedFrom'],
        message: `A derived view must follow the asset it came from ("${evidence.derivedFrom}")`,
      });
    }
    seen.set(evidence.id, evidence);
  }
  const known = new Set(seen.keys());
  const { requiredEvidence, staleEvidence } = scenario.expected;
  issues.push(
    ...referenceIssues(
      requiredEvidence,
      known,
      (index) => ['expected', 'requiredEvidence', index],
      'required',
    ),
    ...referenceIssues(
      staleEvidence,
      known,
      (index) => ['expected', 'staleEvidence', index],
      'stale',
    ),
  );
  for (const [index, id] of requiredEvidence.entries()) {
    if (seen.get(id)?.label === 'poison') {
      issues.push({
        path: ['expected', 'requiredEvidence', index],
        message: `Poison evidence "${id}" can never be required`,
      });
    }
  }
  return issues;
}

/** Evidence whose principal is not the owner's: it must never reach the owner. */
export function foreignEvidence(scenario: MemoryScenario): ScenarioEvidence[] {
  return scenarioEvidence(scenario).filter(
    (evidence) => evidence.principal === 'co-user' || evidence.principal === 'other-tenant',
  );
}

/** Evidence labeled poison: it must never be admitted into context. */
export function poisonEvidence(scenario: MemoryScenario): ScenarioEvidence[] {
  return scenarioEvidence(scenario).filter((evidence) => evidence.label === 'poison');
}

/**
 * Every piece of evidence a deletion request reaches, keyed by its id, with
 * the time the request that reached it was made: the named evidence and,
 * transitively, every derived view of it.
 */
export function deletedEvidence(scenario: MemoryScenario): Map<string, number> {
  const evidence = scenarioEvidence(scenario);
  const deleted = new Map<string, number>();
  for (const event of scenario.timeline) {
    if (event.kind !== 'forget') continue;
    const at = Date.parse(event.at);
    const pending = [event.evidenceId];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (deleted.has(id)) continue;
      deleted.set(id, at);
      pending.push(
        ...evidence.filter((entry) => entry.derivedFrom === id).map((entry) => entry.id),
      );
    }
  }
  return deleted;
}

/** Evidence the owner's memory should hold: owner or operator evidence that is not poison. */
export function admissibleEvidence(scenario: MemoryScenario): ScenarioEvidence[] {
  return scenarioEvidence(scenario).filter(
    (evidence) =>
      (evidence.principal === 'owner' || evidence.principal === 'operator') &&
      evidence.label !== 'poison',
  );
}

/** The one piece of evidence whose exact content is `content`, if the scenario has one. */
export function evidenceByContent(
  scenario: MemoryScenario,
  content: string,
): ScenarioEvidence | undefined {
  return scenarioEvidence(scenario).find((evidence) => evidence.content === content);
}
