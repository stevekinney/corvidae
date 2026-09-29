/**
 * Offline comparison scenarios over the representative dataset. Every
 * participant is a real operative agent whose provider is scripted with
 * `createScriptedGenerate`, and every run's cost is estimated at one priced
 * model, so a scenario runs anywhere and reproduces byte for byte from its
 * runtime seed. Latency comes from a manual runtime clock each participant
 * advances as it answers.
 *
 * Each scenario answers from what its participants can actually see:
 *
 * - `vault-code` (partitioned search, distributed information): each
 *   sampler and searcher sees one ledger shard. Samplers can only guess the
 *   digits they cannot see, so their majority vote misses the code; the
 *   collaboration's searchers report their digits to the reducer, which
 *   commits the whole code.
 * - `negative-control` (direct): one Agent already answers correctly; the
 *   collaboration's finisher rewrites the drafter's answer into prose and
 *   fails the exact contract while spending more.
 * - `ungoverned-scratchpad` (shared state): the clerks write only to an
 *   undeclared scratchpad, so nothing coordinates them and the keeper loses
 *   an update.
 */
import {
  createAgent,
  createManualRuntimeServices,
  createScriptedGenerate,
  estimateCost,
  type RunResultBase,
  type TokenUsage,
} from '@lostgradient/operative';

import type { CollaborationRun, ComparisonSubjects, RunComparisonOptions } from '../../comparison';
import { parseComparisonDataset, toEvaluationDataset } from '../../comparison-datasets';
import { createEvaluator, type Evaluator } from '../../evaluator';
import type { TrajectoryEvent } from '../../trajectory';
import type { TrialSubject } from '../../trials';
import { REPRESENTATIVE_SUCCESS_HEURISTICS } from './heuristics';
import {
  directCollaborationPlanInput,
  directPlanInput,
  ensemblePlanInput,
  partitionedSearchPlanInput,
  sharedStatePlanInput,
} from './plans';
import representativeDataset from './representative-dataset.json';

export const FIXTURE_MODEL = 'claude-sonnet-4-20250514';
export const FIXTURE_CODE_REVISION = '857d7dbf6e2a7c1a9f0b3d4e5f60718293a4b5c6';
export const FIXTURE_REPETITIONS = 3;
export const AGENT_USAGE: TokenUsage = { prompt: 400, completion: 100, total: 500 };
/** How long each scripted participant takes to answer, on the manual clock. */
export const TURN_MILLISECONDS = 250;

export type FixtureRuntime = ReturnType<typeof createManualRuntimeServices>;

export function fixtureRuntime(randomSeed = 'collaboration-comparison'): FixtureRuntime {
  return createManualRuntimeServices({
    randomSeed,
    identifierSeed: 'collaboration-comparison',
    origin: '2026-09-28T00:00:00.000Z',
  });
}

/** The comparison's own rubric: the verifier whose acceptance each profile reports. */
export function comparisonEvaluatorConfiguration(): Record<string, unknown> {
  return {
    name: 'collaboration-comparison',
    revision: 1,
    passThreshold: 1,
    criteria: [
      {
        name: 'states-one-answer',
        kind: 'deterministic-assertion',
        description: 'The final answer is one non-empty line.',
        weight: 1,
        hardThreshold: 1,
      },
      {
        name: 'no-web-search',
        kind: 'trajectory',
        description: 'No participant searched the web for the answer.',
        weight: 1,
        hardThreshold: 1,
        forbiddenTools: ['web_search'],
        requiredTools: [],
      },
    ],
    examples: [],
    referenceMaterial: { version: 'comparison-reference-1', entries: [] },
    judge: { kind: 'deterministic', name: 'comparison-checks' },
    promptVersion: 'comparison-checks-1',
    datasetVersion: representativeDataset.version,
    environment: { name: 'scripted-generate', revision: 'collaboration-comparison-1' },
    budgets: {
      perEvaluation: { costUsd: 0.05, latencyMilliseconds: 30_000 },
      perGateRun: { costUsd: 5, latencyMilliseconds: 600_000 },
    },
    repetitions: FIXTURE_REPETITIONS,
    variancePolicy: {
      name: 'two-of-three',
      version: '1',
      minimumPassFraction: 0.6,
      maximumIntervalWidth: 0.75,
    },
    resultSchemaVersion: 1,
    codeRevision: FIXTURE_CODE_REVISION,
  };
}

export function comparisonEvaluator(
  configuration: Record<string, unknown> = comparisonEvaluatorConfiguration(),
): Promise<Evaluator> {
  return createEvaluator({
    configuration,
    dataset: toEvaluationDataset(parseComparisonDataset(representativeDataset)),
    scorers: {
      assertions: {
        'states-one-answer': ({ result }) => {
          const answer = result.content.trim();
          return answer.length > 0 && !answer.includes('\n');
        },
      },
    },
  });
}

export interface DefinitionOptions {
  readonly id: string;
  readonly agents: readonly string[];
  readonly caseIds: readonly string[];
  readonly aggregation?: 'majority-vote' | 'reducer';
}

export function definitionInput(options: DefinitionOptions): Record<string, unknown> {
  const aggregation = options.aggregation ?? 'majority-vote';
  return {
    id: options.id,
    agents: options.agents.map((name) => ({
      name,
      model: FIXTURE_MODEL,
      effort: 'medium',
      definitionRevision: `${name}-definition-1`,
      promptRevision: `${name}-prompt-1`,
      tools: ['ledger_lookup'],
    })),
    tools: [{ name: 'ledger_lookup', revision: 'ledger-lookup-1' }],
    dataRevision: 'collaboration-comparison-data-1',
    concurrency: 2,
    computeMatch: { kind: 'participant-count' },
    aggregation: { kind: aggregation, name: aggregation, version: '1' },
    stoppingRule: {
      name: 'commit-or-exhaust',
      version: '1',
      description: 'Stop once the commit authority commits or the round budget is spent.',
    },
    caseIds: [...options.caseIds],
  };
}

/** A fresh one-turn operative agent answering `content`, advancing the clock and estimating cost. */
export function scriptedAgent(
  runtime: FixtureRuntime,
  name: string,
  content: string | ((input: string) => string),
): TrialSubject {
  return {
    run: (input) => {
      const answer = typeof content === 'string' ? content : content(input);
      const agent = createAgent({
        name,
        generate: createScriptedGenerate([
          { kind: 'respond', response: { content: answer, toolCalls: [], usage: AGENT_USAGE } },
        ]),
      });
      const run = agent.run(input);
      return {
        result: async () => {
          const result = await run.result();
          await runtime.advance(TURN_MILLISECONDS);
          return { ...result, costEstimate: estimateCost(result.usage, FIXTURE_MODEL) };
        },
      };
    },
  };
}

/** Runs each participant once, in order, and folds their runs into the committed result. */
export async function collaborate(
  turns: readonly { readonly subject: TrialSubject; readonly input: string }[],
  trajectory: readonly TrajectoryEvent[],
): Promise<CollaborationRun> {
  const runs: RunResultBase[] = [];
  for (const turn of turns) runs.push(await turn.subject.run(turn.input).result());
  const final = runs.at(-1) as RunResultBase;
  const usage = {
    prompt: runs.reduce((sum, run) => sum + run.usage.prompt, 0),
    completion: runs.reduce((sum, run) => sum + run.usage.completion, 0),
    total: runs.reduce((sum, run) => sum + run.usage.total, 0),
  };
  return {
    result: {
      ...final,
      steps: runs.flatMap((run) => run.steps),
      usage,
      costEstimate: estimateCost(usage, FIXTURE_MODEL),
    },
    trajectory,
  };
}

/** A shard-limited answer: the digits this input reveals in place, `0` for the rest. */
export function answerFromShards(input: string): string {
  const digits = ['0', '0', '0'];
  for (const match of input.matchAll(/Shard ([ABC]) records the digit (\d)\./g)) {
    digits['ABC'.indexOf(match[1] as string)] = match[2] as string;
  }
  return digits.join('');
}

function started(...participants: string[]): TrajectoryEvent[] {
  return participants.map((participant) => ({ type: 'participant-started', participant }));
}

function finished(...participants: string[]): TrajectoryEvent[] {
  return participants.map((participant) => ({
    type: 'participant-finished',
    participant,
    outcome: 'completed',
  }));
}

function finding(from: string, to: string, subject: string, digest: string): TrajectoryEvent {
  return {
    type: 'message',
    message: {
      intent: 'observation',
      sender: from,
      recipient: to,
      relationship: 'peer',
      source: subject,
      trustClass: 'untrusted-claim',
      schema: 'finding-1',
      subject,
      provenance: 'epoch-1',
      correlation: `${from}-handoff`,
    },
    tokens: 40,
    contentDigest: digest,
  };
}

const SEARCHERS = ['searcher-a', 'searcher-b', 'searcher-c'] as const;
const SAMPLERS = ['sampler-1', 'sampler-2', 'sampler-3', 'sampler-4'] as const;

/** The partitioned-search trajectory: three shard reports, one reducer commit, everyone finished. */
export function vaultTrajectory(): TrajectoryEvent[] {
  return [
    ...started(...SEARCHERS, 'reducer'),
    ...SEARCHERS.map((participant, index): TrajectoryEvent => ({
      type: 'handoff',
      participant,
      sources: [`shard-${'abc'[index]}`],
    })),
    ...SEARCHERS.map((participant, index): TrajectoryEvent => ({
      type: 'work',
      participant,
      unit: `shard-${'abc'[index]}`,
    })),
    ...SEARCHERS.map((from, index) => finding(from, 'reducer', `digit-${index}`, `digit-${index}`)),
    {
      type: 'artifact-write',
      participant: 'reducer',
      artifactId: 'answer',
      baseRevision: 0,
      intent: 'commit',
    },
    ...finished(...SEARCHERS, 'reducer'),
  ];
}

export function vaultSubjects(runtime: FixtureRuntime): ComparisonSubjects {
  return {
    direct: ({ participant }) => scriptedAgent(runtime, participant, answerFromShards),
    ensembleSample: ({ participant }) => scriptedAgent(runtime, participant, answerFromShards),
    collaboration: ({ inputs }) =>
      collaborate(
        [
          ...SEARCHERS.map((name) => ({
            subject: scriptedAgent(runtime, name, answerFromShards),
            input: inputs[name] as string,
          })),
          { subject: scriptedAgent(runtime, 'reducer', '472'), input: inputs['reducer'] as string },
        ],
        vaultTrajectory(),
      ),
  };
}

export type ComparisonScenario = RunComparisonOptions & { readonly runtime: FixtureRuntime };

export async function vaultCodeScenario(runtime = fixtureRuntime()): Promise<ComparisonScenario> {
  return {
    definition: definitionInput({
      id: 'vault-code',
      agents: ['solver', ...SAMPLERS, ...SEARCHERS, 'reducer'],
      caseIds: ['partitioned-search-vault-code'],
    }),
    plans: {
      direct: directPlanInput('partitioned-search'),
      ensemble: ensemblePlanInput('partitioned-search', SAMPLERS),
      collaboration: partitionedSearchPlanInput(),
    },
    dataset: representativeDataset,
    evaluator: await comparisonEvaluator(),
    subjects: vaultSubjects(runtime),
    successHeuristics: REPRESENTATIVE_SUCCESS_HEURISTICS,
    runtime,
  };
}

export async function negativeControlScenario(
  runtime = fixtureRuntime(),
): Promise<ComparisonScenario> {
  const trajectory: TrajectoryEvent[] = [
    ...started('drafter', 'finisher'),
    finding('drafter', 'finisher', 'product', 'product-391'),
    ...finished('drafter', 'finisher'),
  ];
  return {
    definition: definitionInput({
      id: 'negative-control',
      agents: ['solver', 'sampler-1', 'sampler-2', 'drafter', 'finisher'],
      caseIds: ['direct-multiplication'],
    }),
    plans: {
      direct: directPlanInput('direct'),
      ensemble: ensemblePlanInput('direct', ['sampler-1', 'sampler-2']),
      collaboration: directCollaborationPlanInput(),
    },
    dataset: representativeDataset,
    evaluator: await comparisonEvaluator(),
    subjects: {
      direct: ({ participant }) => scriptedAgent(runtime, participant, '391'),
      ensembleSample: ({ participant }) => scriptedAgent(runtime, participant, '391'),
      collaboration: ({ inputs }) =>
        collaborate(
          [
            {
              subject: scriptedAgent(runtime, 'drafter', '391'),
              input: inputs['drafter'] as string,
            },
            {
              subject: scriptedAgent(runtime, 'finisher', 'The product of 17 and 23 is 391.'),
              input: inputs['finisher'] as string,
            },
          ],
          trajectory,
        ),
    },
    successHeuristics: REPRESENTATIVE_SUCCESS_HEURISTICS,
    runtime,
  };
}

export async function ungovernedScratchpadScenario(
  runtime = fixtureRuntime(),
): Promise<ComparisonScenario> {
  const scratch = (participant: string): TrajectoryEvent => ({
    type: 'artifact-write',
    participant,
    artifactId: 'scratchpad',
    baseRevision: 0,
    intent: 'proposal',
  });
  const trajectory: TrajectoryEvent[] = [
    ...started('clerk-one', 'clerk-two', 'keeper'),
    scratch('clerk-one'),
    scratch('clerk-two'),
    { type: 'artifact-read', participant: 'keeper', artifactId: 'scratchpad', revision: 0 },
    ...finished('clerk-one', 'clerk-two', 'keeper'),
  ];
  const samplers = ['sampler-1', 'sampler-2', 'sampler-3'];
  return {
    definition: definitionInput({
      id: 'ungoverned-scratchpad',
      agents: ['solver', ...samplers, 'clerk-one', 'clerk-two', 'keeper'],
      caseIds: ['shared-state-ungoverned-scratchpad'],
    }),
    plans: {
      direct: directPlanInput('shared-state'),
      ensemble: ensemblePlanInput('shared-state', samplers),
      collaboration: sharedStatePlanInput(),
    },
    dataset: representativeDataset,
    evaluator: await comparisonEvaluator(),
    subjects: {
      direct: ({ participant }) => scriptedAgent(runtime, participant, '8'),
      ensembleSample: ({ participant }) => scriptedAgent(runtime, participant, '8'),
      collaboration: ({ inputs }) =>
        collaborate(
          ['clerk-one', 'clerk-two']
            .map((name) => ({
              subject: scriptedAgent(runtime, name, 'Recorded a shipment of 4 units.'),
              input: inputs[name] as string,
            }))
            .concat([
              {
                subject: scriptedAgent(runtime, 'keeper', '12'),
                input: inputs['keeper'] as string,
              },
            ]),
          trajectory,
        ),
    },
    successHeuristics: REPRESENTATIVE_SUCCESS_HEURISTICS,
    runtime,
  };
}
