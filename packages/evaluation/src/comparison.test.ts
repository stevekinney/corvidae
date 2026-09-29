import { describe, expect, test } from 'bun:test';

import { sha256Hex } from '@lostgradient/cryptography';
import type { RunResultBase } from '@lostgradient/operative';
import { throwingRejectionOf } from '@lostgradient/testing';

import {
  bindComparison,
  type CaseComparison,
  type CollaborationContext,
  comparisonResultSchema,
  type ComparisonSubjects,
  majorityVote,
  type ParticipantContext,
  runComparison,
  sampleSeed,
  totalsOf,
} from './comparison';
import { EvaluatorConfigurationError } from './configuration';
import { datasetInput, runResult } from './evaluation.test-support';
import { createEvaluator } from './evaluator';
import {
  directPlanInput,
  ensemblePlanInput,
  fullyConnectedPlanInput,
  planInput,
  verifierRevisionPlanInput,
} from './fixtures/comparison/plans';
import {
  collaborate,
  comparisonEvaluator,
  comparisonEvaluatorConfiguration,
  type ComparisonScenario,
  definitionInput,
  fixtureRuntime,
  scriptedAgent,
  vaultCodeScenario,
  vaultTrajectory,
} from './fixtures/comparison/scenarios';
import { canonicalJson } from './identity';
import { type TrajectoryEvent } from './trajectory';
import type { TrialSubject } from './trials';

type Mutable = Record<string, any>;

function stub(result: RunResultBase | (() => Promise<RunResultBase>)): TrialSubject {
  return {
    run: () => ({ result: typeof result === 'function' ? result : async () => result }),
  };
}

async function scenario(change: (draft: Mutable) => void = () => {}): Promise<ComparisonScenario> {
  const base = await vaultCodeScenario();
  const draft = {
    ...base,
    definition: structuredClone(base.definition),
    plans: structuredClone(base.plans),
    subjects: { ...base.subjects },
  } as Mutable;
  change(draft);
  return draft as ComparisonScenario;
}

async function issuesOf(options: Parameters<typeof bindComparison>[0]): Promise<string[]> {
  try {
    await bindComparison(options);
  } catch (error) {
    if (!(error instanceof EvaluatorConfigurationError)) throw error;
    return error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);
  }
  return [];
}

/** The one case a single-case comparison ran. */
async function firstCase(options: ComparisonScenario): Promise<CaseComparison> {
  const result = await runComparison(options);
  return result.cases[0]!;
}

describe('runComparison over the distributed-information vault code', () => {
  test('runs the case under all three profiles and binds everything that could change the outcome', async () => {
    const options = await vaultCodeScenario();
    const result = await runComparison(options);
    expect(comparisonResultSchema.safeParse(result).success).toBe(true);

    const { binding } = result;
    expect(result.revision).toBe(await sha256Hex(canonicalJson(binding)));
    expect(binding.schemaVersion).toBe(1);
    expect(binding.trials).toBe(3);
    expect(binding.evaluator).toEqual(options.evaluator.identity);
    expect(binding.dataset).toEqual({
      id: 'collaboration-comparison',
      version: 'collaboration-comparison-2026-09',
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const { definition, plans } = binding;
    expect(definition.agents[0]).toEqual({
      name: 'solver',
      model: 'claude-sonnet-4-20250514',
      effort: 'medium',
      definitionRevision: 'solver-definition-1',
      promptRevision: 'solver-prompt-1',
      tools: ['ledger_lookup'],
    });
    expect(definition.tools).toEqual([{ name: 'ledger_lookup', revision: 'ledger-lookup-1' }]);
    expect(definition.dataRevision).toBe('collaboration-comparison-data-1');
    expect(definition.concurrency).toBe(2);
    expect(definition.aggregation).toEqual({
      kind: 'majority-vote',
      name: 'majority-vote',
      version: '1',
    });
    expect(definition.stoppingRule.name).toBe('commit-or-exhaust');
    expect(definition).not.toHaveProperty('caseIds');
    expect(binding.cases).toEqual([
      { ordinal: 3, visibility: 'public', caseId: 'partitioned-search-vault-code' },
    ]);
    expect(Object.keys(plans)).toEqual([
      'direct-agent',
      'compute-matched-ensemble',
      'collaboration',
    ]);
    expect(plans.collaboration.topology.edges).toHaveLength(3);
    expect(plans.collaboration.contextProjections).toHaveLength(3);
    expect(plans.collaboration.resourceEnvelope.tokens).toBe(20_000);
    expect(plans['direct-agent'].resourceEnvelope).toEqual(plans.collaboration.resourceEnvelope);

    const [entry] = result.cases;
    expect(entry).toMatchObject({
      ordinal: 3,
      visibility: 'public',
      caseId: 'partitioned-search-vault-code',
      taskClass: 'partitioned-search',
      controls: ['distributed-information'],
    });
    expect(entry?.seeds).toHaveLength(3);
    for (const profile of Object.values(entry!.profiles)) {
      expect(profile.trials.map((trial) => trial.seed)).toEqual(entry!.seeds);
    }
  });

  test('separates task success, verifier acceptance, cost, latency, and coordination per profile', async () => {
    const { profiles } = await firstCase(await vaultCodeScenario());
    const direct = profiles['direct-agent'];
    const ensemble = profiles['compute-matched-ensemble'];
    const collaboration = profiles.collaboration;

    // The direct Agent and every sampler see one shard; only the collaboration combines all three.
    expect(direct.taskSuccess.passFraction).toBe(0);
    expect(ensemble.taskSuccess.passFraction).toBe(0);
    expect(collaboration.taskSuccess.passFraction).toBe(1);
    expect(collaboration.taskSuccess.wilsonInterval?.lower).toBeCloseTo(0.4385, 4);
    // The rubric accepts every profile's one-line answer; task success is a separate fact.
    for (const profile of [direct, ensemble, collaboration]) {
      expect(profile.verifierAcceptance.passFraction).toBe(1);
      expect(profile.outcome).toBe('pass');
      expect(profile.criteria.map((criterion) => criterion.name)).toEqual([
        'states-one-answer',
        'no-web-search',
      ]);
    }

    expect(direct.totals).toMatchObject({
      trialsWithRuns: 3,
      latencyMillisecondsMean: 250,
      tokens: 1500,
      steps: 3,
      toolCalls: 0,
      coordinationTurns: 0,
      duplicateWork: 0,
      cleanup: 'quiescent',
    });
    expect(direct.totals.costUsd).toBeCloseTo(0.0081, 10);
    // Four independent samples of one complete solution duplicate it three times per trial.
    expect(ensemble.totals).toMatchObject({ tokens: 6000, duplicateWork: 9, coordinationTurns: 0 });
    expect(ensemble.trials[0]?.sampleSeeds).toHaveLength(4);
    expect(collaboration.totals).toMatchObject({
      tokens: 6000,
      coordinationTurns: 9,
      coordinationTokens: 360,
      messageNovelty: 1,
      duplicateWork: 0,
      failureLabels: [],
      envelopeBreaches: [],
    });
    expect(collaboration.trials[0]).toMatchObject({
      verdict: 'pass',
      finishReason: 'stop-condition',
      taskSuccess: true,
      latencyMilliseconds: 1000,
      tokens: 2000,
      steps: 4,
      failures: [],
      cleanup: { state: 'quiescent', detached: [], abandoned: [] },
      envelopeBreaches: [],
      error: null,
    });
  });

  test('is deterministic from its runtime seed, and replays byte for byte from recorded seeds', async () => {
    const first = await runComparison(await vaultCodeScenario(fixtureRuntime('seed-one')));
    const again = await runComparison(await vaultCodeScenario(fixtureRuntime('seed-one')));
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));

    const other = await runComparison(await vaultCodeScenario(fixtureRuntime('seed-two')));
    expect(other.cases[0]?.seeds).not.toEqual(first.cases[0]?.seeds);

    const replayed = await runComparison({
      ...(await vaultCodeScenario(fixtureRuntime('seed-two'))),
      seeds: { 'partitioned-search-vault-code': first.cases[0]!.seeds },
    });
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(first));
  });

  test('draws seeds from the real runtime services when none is injected', async () => {
    const result = await runComparison({ ...(await vaultCodeScenario()), runtime: undefined });
    for (const seed of result.cases[0]!.seeds) {
      expect(Number.isInteger(seed) && seed >= 0 && seed < 0x1_0000_0000).toBe(true);
    }
  });

  test('records every ensemble sample’s seed and runs no more samples at once than its concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const contexts: ParticipantContext[] = [];
    const options = await scenario((draft) => {
      const runtime = draft['runtime'];
      draft['subjects'].ensembleSample = (context: ParticipantContext) => {
        contexts.push(context);
        const inner = scriptedAgent(runtime, context.participant, '400');
        return {
          run: (input: string) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            const run = inner.run(input);
            return {
              result: async () => {
                const result = await run.result();
                inFlight -= 1;
                return result;
              },
            };
          },
        };
      };
    });
    const result = await runComparison(options);
    expect(peak).toBe(2);
    const trial = result.cases[0]!.profiles['compute-matched-ensemble'].trials[0]!;
    expect(trial.sampleSeeds).toEqual([0, 1, 2, 3].map((index) => sampleSeed(trial.seed, index)));
    expect(contexts.slice(0, 4)).toEqual(
      ['sampler-1', 'sampler-2', 'sampler-3', 'sampler-4'].map((participant, index) => ({
        trial: 1,
        seed: trial.sampleSeeds[index] as number,
        participant,
      })),
    );
  });

  test('aggregates with a reducer that reads every sample, when the definition says so', async () => {
    const inputs: string[] = [];
    const options = await scenario((draft) => {
      const runtime = draft['runtime'];
      draft['definition'].aggregation = { kind: 'reducer', name: 'shard-reducer', version: '2' };
      draft['definition'].agents.push({ ...draft['definition'].agents[0], name: 'aggregator' });
      draft['plans'].ensemble = ensemblePlanInput(
        'partitioned-search',
        ['sampler-1', 'sampler-2', 'sampler-3'],
        'aggregator',
      );
      draft['subjects'].ensembleReducer = (context: ParticipantContext) => {
        const inner = scriptedAgent(runtime, context.participant, '472');
        return {
          run: (input: string) => {
            inputs.push(input);
            return inner.run(input);
          },
        };
      };
    });
    const result = await runComparison(options);
    const ensemble = result.cases[0]!.profiles['compute-matched-ensemble'];
    expect(ensemble.taskSuccess.passFraction).toBe(1);
    expect(ensemble.trials[0]?.sampleSeeds).toHaveLength(4);
    expect(ensemble.totals.tokens).toBe(6000);
    expect(ensemble.totals.duplicateWork).toBe(6);
    expect(inputs[0]).toEndWith('Candidate answers:\n1. 400\n2. 070\n3. 002');
  });

  test('refuses reducer aggregation without a reducer subject', async () => {
    const options = await scenario((draft) => {
      draft['definition'].aggregation = { kind: 'reducer', name: 'shard-reducer', version: '2' };
      draft['definition'].agents.push({ ...draft['definition'].agents[0], name: 'aggregator' });
      draft['plans'].ensemble = ensemblePlanInput(
        'partitioned-search',
        ['sampler-1', 'sampler-2', 'sampler-3'],
        'aggregator',
      );
    });
    expect(await throwingRejectionOf(runComparison(options))).toThrow(
      'subjects.ensembleReducer: Reducer aggregation needs an ensembleReducer subject',
    );
  });
});

describe('failures during a trial', () => {
  test('a collaboration subject that throws is an infrastructure failure with no metrics, never a verdict', async () => {
    const options = await scenario((draft) => {
      draft['subjects'].collaboration = async () => {
        throw new Error('The collaboration runtime crashed');
      };
    });
    const {
      profiles: { collaboration },
    } = await firstCase(options);
    expect(collaboration.outcome).toBe('indeterminate');
    expect(collaboration.trials[0]).toEqual({
      trial: 1,
      seed: collaboration.trials[0]!.seed,
      sampleSeeds: [],
      verdict: 'infrastructure-failure',
      finishReason: null,
      taskSuccess: null,
      costUsd: null,
      latencyMilliseconds: null,
      tokens: null,
      toolCalls: null,
      steps: null,
      coordination: null,
      failures: [],
      cleanup: null,
      envelopeBreaches: [],
      error: 'subject-error',
    });
    expect(collaboration.taskSuccess).toEqual({
      trials: 0,
      passes: 0,
      passFraction: null,
      wilsonInterval: null,
    });
    // Nothing was observed, so no total may read as a measured zero or a measured absence.
    expect(collaboration.totals).toEqual(totalsOf([]));
    expect(collaboration.totals.trialsWithRuns).toBe(0);
    expect(collaboration.totals.tokens).toBeNull();
    expect(collaboration.totals.propagatedFaults).toBeNull();
  });

  test('a malformed trajectory is a subject error too', async () => {
    const options = await scenario((draft) => {
      draft['subjects'].collaboration = async () => ({
        result: runResult({ content: '472' }),
        trajectory: [{ type: 'gossip' }],
      });
    });
    const { profiles } = await firstCase(options);
    const trial = profiles.collaboration.trials[0]!;
    expect(trial.error).toBe('subject-error');
  });

  test('a failing ensemble sample fails the trial only after every sample in its batch settles', async () => {
    const settled: string[] = [];
    const options = await scenario((draft) => {
      const runtime = draft['runtime'];
      draft['subjects'].ensembleSample = ({ participant }: ParticipantContext) => {
        if (participant === 'sampler-1') throw new Error('sampler-1 could not start');
        const inner = scriptedAgent(runtime, participant, '400');
        return {
          run: (input: string) => {
            const run = inner.run(input);
            return {
              result: async () => {
                const result = await run.result();
                settled.push(participant);
                return result;
              },
            };
          },
        };
      };
    });
    const { profiles } = await firstCase(options);
    const ensemble = profiles['compute-matched-ensemble'];
    expect(ensemble.trials.map((trial) => trial.error)).toEqual([
      'subject-error',
      'subject-error',
      'subject-error',
    ]);
    // sampler-2 shared sampler-1's batch and still finished; the next batch never started.
    expect(settled).toEqual(['sampler-2', 'sampler-2', 'sampler-2']);
  });

  test('an Agent that stops early fails its task; an aborted one is recorded as cancelled', async () => {
    const options = await scenario((draft) => {
      draft['subjects'].direct = () =>
        stub(runResult({ content: '472', finishReason: 'maximum-steps' }));
      draft['subjects'].ensembleSample = () =>
        stub(runResult({ content: '472', finishReason: 'aborted' }));
    });
    const { profiles } = await firstCase(options);
    const direct = profiles['direct-agent'].trials[0]!;
    expect(direct).toMatchObject({
      verdict: 'agent-failed',
      finishReason: 'maximum-steps',
      taskSuccess: false,
      costUsd: null,
    });
    expect(profiles['direct-agent'].totals.costUsd).toBeNull();
    // With no completed sample the first sample stands, so the ensemble fails as it failed.
    expect(profiles['compute-matched-ensemble'].trials[0]).toMatchObject({
      verdict: 'agent-failed',
      finishReason: 'aborted',
      taskSuccess: false,
    });
  });

  test('labels an in-run verifier that accepted a result failing the success contract', async () => {
    const accepted: TrajectoryEvent = {
      type: 'message',
      message: {
        intent: 'verification-result',
        sender: 'counter',
        recipient: 'writer',
        relationship: 'verifier-producer',
        source: 'draft',
        trustClass: 'untrusted-claim',
        schema: 'verdict-1',
        subject: 'sentence',
        provenance: 'epoch-1',
        correlation: 'draft-1',
        evidenceDigest: 'sha256:count',
      },
      tokens: 12,
      contentDigest: 'accepted',
      verdict: 'accepted',
    };
    const options = await revisionScenario(
      ['Rivers run.', 'Rivers carve patient valleys through ancient stone.'],
      [accepted],
    );
    const {
      profiles: { collaboration },
    } = await firstCase(options);
    expect(collaboration.taskSuccess.passFraction).toBe(0);
    expect(collaboration.trials[0]?.failures).toEqual([
      {
        label: 'missing-or-incorrect-verification',
        participant: null,
        event: null,
        evidence: 'An in-run verifier accepted a result that fails the success contract',
      },
    ]);
    expect(collaboration.totals.failureLabels).toEqual([
      { label: 'missing-or-incorrect-verification', count: 3 },
    ]);
  });

  test('records every breach of the resource envelope', async () => {
    const options = await scenario((draft) => {
      const runtime = draft['runtime'];
      draft['subjects'].collaboration = async () => {
        await runtime.advance(70_000);
        const heavy = runResult({
          content: '472',
          toolCalls: Array.from({ length: 41 }, () => ({ name: 'ledger_lookup' })),
        });
        const participants = ['searcher-a', 'searcher-b', 'searcher-c', 'reducer', 'auditor'];
        return {
          result: {
            ...heavy,
            usage: { prompt: 25_000, completion: 5_000, total: 30_000 },
            costEstimate: {
              promptCost: 0.75,
              completionCost: 0.25,
              cacheWriteCost: 0,
              cacheReadCost: 0,
              totalCost: 1,
              model: 'claude-sonnet-4-20250514',
              usage: heavy.usage,
            },
          },
          trajectory: participants.map((participant) => ({
            type: 'participant-started',
            participant,
          })),
        };
      };
    });
    const { profiles } = await firstCase(options);
    const trial = profiles.collaboration.trials[0]!;
    expect(trial.envelopeBreaches).toEqual([
      'tokens',
      'cost',
      'wall-clock',
      'steps',
      'fan-out',
      'descendants',
    ]);
    expect(trial.toolCalls).toBe(41);
    expect(trial.cleanup?.state).toBe('abandoned');
  });

  test('holds participants that act without a recorded start against the fan-out and descendants', async () => {
    const participants = ['searcher-a', 'searcher-b', 'searcher-c', 'reducer', 'auditor'];
    const options = await scenario((draft) => {
      draft['subjects'].collaboration = async () => ({
        result: runResult({ content: '472' }),
        trajectory: participants.map((participant) => ({
          type: 'work',
          participant,
          unit: `${participant}-unit`,
        })),
      });
    });
    const { profiles } = await firstCase(options);
    const trial = profiles.collaboration.trials[0]!;
    expect(trial.envelopeBreaches).toEqual(['fan-out', 'descendants']);
    expect(trial.cleanup).toEqual({ state: 'abandoned', detached: [], abandoned: participants });
  });
});

/**
 * A verifier-revision comparison: the collaboration's writer answers
 * `answers[0]`, and the direct Agent and every sampler answer `answers[1]`.
 */
async function revisionScenario(
  answers: readonly [string, string],
  extra: readonly TrajectoryEvent[],
): Promise<ComparisonScenario> {
  const runtime = fixtureRuntime();
  const base = await vaultCodeScenario(runtime);
  const trajectory: TrajectoryEvent[] = [
    { type: 'participant-started', participant: 'writer' },
    { type: 'participant-started', participant: 'counter' },
    ...extra,
    { type: 'participant-finished', participant: 'writer', outcome: 'completed' },
    { type: 'participant-finished', participant: 'counter', outcome: 'completed' },
  ];
  const subjects: ComparisonSubjects = {
    direct: ({ participant }) => scriptedAgent(runtime, participant, answers[1]),
    ensembleSample: ({ participant }) => scriptedAgent(runtime, participant, answers[1]),
    collaboration: ({ inputs }: CollaborationContext) =>
      collaborate(
        [
          {
            subject: scriptedAgent(runtime, 'counter', 'Checked.'),
            input: inputs['counter'] as string,
          },
          {
            subject: scriptedAgent(runtime, 'writer', answers[0]),
            input: inputs['writer'] as string,
          },
        ],
        trajectory,
      ),
  };
  return {
    definition: definitionInput({
      id: 'seven-words',
      agents: ['solver', 'sampler-1', 'sampler-2', 'writer', 'counter'],
      caseIds: ['verifier-revision-seven-words'],
    }),
    plans: {
      direct: directPlanInput('verifier-revision'),
      ensemble: ensemblePlanInput('verifier-revision', ['sampler-1', 'sampler-2']),
      collaboration: verifierRevisionPlanInput(),
    },
    dataset: base.dataset,
    evaluator: await comparisonEvaluator(),
    subjects,
    successHeuristics: base.successHeuristics,
    runtime,
  };
}

describe('cases', () => {
  test('scores a versioned heuristic success contract with its registered scorer', async () => {
    const result = await runComparison(
      await revisionScenario(
        ['Rivers carve patient valleys through ancient stone.', 'Rivers run.'],
        [],
      ),
    );
    const { profiles } = result.cases[0]!;
    expect(profiles.collaboration.taskSuccess.passFraction).toBe(1);
    expect(profiles['direct-agent'].taskSuccess.passFraction).toBe(0);
  });

  test('records a held-out case by ordinal alone', async () => {
    const runtime = fixtureRuntime();
    const answer = (participant: string) => scriptedAgent(runtime, participant, '16');
    const base = await vaultCodeScenario(runtime);
    const sequential = (
      profile: string,
      participants: readonly { agentName: string; role: 'producer' | 'commit-authority' }[],
    ) =>
      planInput({
        planId: `${profile}-plan`,
        taskClass: 'sequential-dependency',
        executionProfile: profile as 'collaboration',
        participants,
        commitAuthority: (participants.at(-1) as { agentName: string }).agentName,
        edges: participants.slice(1).map((participant, index) => ({
          from: (participants[index] as { agentName: string }).agentName,
          to: participant.agentName,
        })),
      });
    const result = await runComparison({
      ...base,
      definition: definitionInput({
        id: 'conversion',
        agents: ['solver', 'sampler-1', 'sampler-2', 'converter', 'rounder'],
        caseIds: ['sequential-dependency-conversion'],
      }),
      plans: {
        direct: directPlanInput('sequential-dependency'),
        ensemble: ensemblePlanInput('sequential-dependency', ['sampler-1', 'sampler-2']),
        collaboration: sequential('collaboration', [
          { agentName: 'converter', role: 'producer' },
          { agentName: 'rounder', role: 'commit-authority' },
        ]),
      },
      subjects: {
        direct: ({ participant }) => answer(participant),
        ensembleSample: ({ participant }) => answer(participant),
        collaboration: ({ inputs }) =>
          collaborate(
            [
              { subject: answer('converter'), input: inputs['converter'] as string },
              { subject: answer('rounder'), input: inputs['rounder'] as string },
            ],
            [],
          ),
      },
    });
    const [entry] = result.cases;
    expect(entry).toMatchObject({ ordinal: 4, visibility: 'held-out' });
    expect(entry).not.toHaveProperty('caseId');
    expect(result.binding.cases).toEqual([{ ordinal: 4, visibility: 'held-out' }]);
    expect(JSON.stringify(result)).not.toContain('sequential-dependency-conversion');
    expect(comparisonResultSchema.safeParse(result).success).toBe(true);
  });
});

describe('bindComparison', () => {
  test('collects every parse issue under its own path', async () => {
    const base = await vaultCodeScenario();
    const definition = structuredClone(base.definition) as Mutable;
    definition['agents'].push({ ...definition['agents'][0] });
    definition['agents'][1].tools = ['web_search'];
    definition['tools'].push({ ...definition['tools'][0] });
    definition['caseIds'].push('partitioned-search-vault-code');
    const issues = await issuesOf({
      ...base,
      definition,
      dataset: { ...(base.dataset as Mutable), cases: [] },
      plans: { ...base.plans, ensemble: { ...(base.plans.ensemble as Mutable), planRevision: 0 } },
    });
    expect(issues).toEqual([
      'definition.agents.9.name: Duplicate agent "solver"',
      'definition.tools.1.name: Duplicate tool "ledger_lookup"',
      'definition.agents.1.tools.0: Tool "web_search" has no bound revision',
      'definition.caseIds.1: Duplicate case id "partitioned-search-vault-code"',
      'dataset.cases: Too small: expected array to have >=1 items',
      'plans.ensemble.planRevision: Too small: expected number to be >0',
    ]);
  });

  test('requires each plan to run its own profile under the collaboration plan’s task, class, policy, and envelope', async () => {
    const base = await vaultCodeScenario();
    const direct = structuredClone(base.plans.direct) as Mutable;
    direct['task'].taskRevision = 'another-task';
    direct['policyVersion'] = 'older-policy';
    direct['resourceEnvelope'].tokens = 40_000;
    const issues = await issuesOf({
      ...base,
      plans: {
        direct,
        ensemble: directPlanInput('direct'),
        collaboration: base.plans.collaboration,
      },
    });
    expect(issues).toEqual([
      'plans.ensemble.executionProfile: The ensemble plan runs the compute-matched-ensemble profile, not direct-agent',
      "plans.direct.task: Every profile shares the collaboration plan's task",
      "plans.direct.policyVersion: Every profile shares the collaboration plan's policyVersion",
      "plans.direct.resourceEnvelope: Every profile shares the collaboration plan's resourceEnvelope",
      "plans.ensemble.taskClass: Every profile shares the collaboration plan's taskClass",
      'plans.ensemble.participants: A participant-count match needs 4 ensemble participants, not 1',
    ]);
  });

  test('keeps the ensemble independent, compute-matched, and within the envelope’s fan-out', async () => {
    const base = await vaultCodeScenario();
    const ensemble = planInput({
      planId: 'ensemble-plan',
      taskClass: 'partitioned-search',
      executionProfile: 'compute-matched-ensemble',
      participants: [
        { agentName: 'sampler-1', role: 'producer' },
        { agentName: 'sampler-2', role: 'verifier' },
        { agentName: 'reducer', role: 'reducer' },
      ],
      commitAuthority: 'reducer',
      edges: [{ from: 'sampler-1', to: 'reducer' }],
    });
    const definition = structuredClone(base.definition) as Mutable;
    definition['concurrency'] = 9;
    expect(await issuesOf({ ...base, definition, plans: { ...base.plans, ensemble } })).toEqual([
      'plans.ensemble.topology.edges: A compute-matched ensemble exchanges no messages, so it has no edges',
      'plans.ensemble.participants: An ensemble is independent producers plus, for reducer aggregation, one reducer',
      'plans.ensemble.participants: majority-vote aggregation takes 0 reducer participants, not 1',
      'plans.ensemble.participants: A participant-count match needs 4 ensemble participants, not 3',
      "definition.concurrency: Concurrency 9 exceeds the envelope's fan-out of 4",
    ]);

    definition['concurrency'] = 2;
    definition['computeMatch'] = {
      kind: 'equivalent-compute',
      reason: 'Two samplers at twice the steps spend what four participants do.',
    };
    const reducers = ensemblePlanInput('partitioned-search', ['sampler-1', 'sampler-2']);
    expect(
      await issuesOf({ ...base, definition, plans: { ...base.plans, ensemble: reducers } }),
    ).toEqual([]);
  });

  test('never refuses a dense collaboration for the loops its edges form (COR-820 amendment row 17b)', async () => {
    const base = await vaultCodeScenario();
    const issues = await issuesOf({
      ...base,
      plans: { ...base.plans, collaboration: fullyConnectedPlanInput(12) },
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(
      issues.filter((issue) => issue.startsWith('plans.collaboration.topology.edges')),
    ).toEqual([]);
  });

  test('binds every participant to an Agent definition', async () => {
    const base = await vaultCodeScenario();
    const definition = structuredClone(base.definition) as Mutable;
    definition['agents'] = definition['agents'].filter(
      (agent: Mutable) => agent['name'] !== 'reducer',
    );
    expect(await issuesOf({ ...base, definition })).toEqual([
      'plans.collaboration.participants.3.agentName: Participant "reducer" is not bound to an Agent definition',
    ]);
  });

  test('requires the evaluator to score this dataset and every case to fit the plans and heuristics', async () => {
    const base = await vaultCodeScenario();
    const definition = structuredClone(base.definition) as Mutable;
    definition['caseIds'] = [
      'partitioned-search-vault-code',
      'no-such-case',
      'direct-multiplication',
      'verifier-revision-seven-words',
    ];
    const foreign = await createEvaluator({
      configuration: { ...comparisonEvaluatorConfiguration(), datasetVersion: 'capitals-2026-09' },
      dataset: datasetInput(),
      scorers: { assertions: { 'states-one-answer': () => true } },
    });
    expect(
      await issuesOf({ ...base, definition, evaluator: foreign, successHeuristics: undefined }),
    ).toEqual([
      'evaluator.dataset: The evaluator must score this comparison dataset, as toEvaluationDataset projects it',
      'definition.caseIds.1: Unknown comparison case "no-such-case"',
      'definition.caseIds.2: Case "direct-multiplication" is a direct task, but the plans are for partitioned-search',
      'definition.caseIds.3: Case "verifier-revision-seven-words" is a verifier-revision task, but the plans are for partitioned-search',
      'definition.caseIds.3: Case "verifier-revision-seven-words" needs the success heuristic "exact-word-count@1"',
    ]);
  });
});

describe('ensemble aggregation helpers', () => {
  test('majorityVote picks the most common completed answer, ties going to the first given', () => {
    const answers = (...contents: string[]) => contents.map((content) => runResult({ content }));
    expect(majorityVote(answers('400', '070', '070', '400'))).toBe(0);
    expect(majorityVote(answers('400', '070', ' 070 ', '002'))).toBe(1);
    const mixed = [
      runResult({ content: '472', finishReason: 'error' }),
      runResult({ content: '070' }),
    ];
    expect(majorityVote(mixed)).toBe(1);
    expect(majorityVote([runResult({ content: '472', finishReason: 'error' })])).toBe(0);
  });

  test('sampleSeed keeps the trial seed for the first sample and steps by the golden ratio after', () => {
    expect(sampleSeed(42, 0)).toBe(42);
    expect(sampleSeed(42, 1)).toBe((42 + 0x9e3779b9) >>> 0);
    expect(sampleSeed(0xffff_ffff, 2)).toBe((0xffff_ffff + 2 * 0x9e3779b9) % 0x1_0000_0000);
  });

  test('totalsOf keeps missing evidence null rather than zero', () => {
    expect(totalsOf([])).toEqual({
      trialsWithRuns: 0,
      costUsd: null,
      latencyMillisecondsMean: null,
      tokens: null,
      toolCalls: null,
      steps: null,
      coordinationTokens: null,
      coordinationTurns: null,
      ungovernedWrites: null,
      duplicateWork: null,
      messageNovelty: null,
      correctedFalseClaims: null,
      unresolvedContradictions: null,
      staleReads: null,
      retries: null,
      replans: null,
      propagatedFaults: null,
      cleanup: null,
      failureLabels: null,
      envelopeBreaches: null,
    });
  });

  test('the vault trajectory fixture is itself clean', () => {
    expect(vaultTrajectory().filter((event) => event.type === 'message')).toHaveLength(3);
  });
});
