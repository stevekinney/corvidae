import { describe, expect, spyOn, test } from 'bun:test';

import {
  type AgentRun,
  createAgent,
  createManualRuntimeServices,
  createScriptedGenerate,
  type RunnableAgent,
  type RunResultBase,
  type ScriptedGenerateStep,
} from '@lostgradient/operative';
import { throwingRejectionOf } from '@lostgradient/testing';

import type { CriterionScorers } from './criteria';
import {
  datasetInput,
  deterministicConfigurationInput,
  judgeReply,
  modelConfigurationInput,
  runResult,
} from './evaluation.test-support';
import { createEvaluator, type Evaluator } from './evaluator';
import tenTrialScores from './fixtures/variance/ten-trial-scores.json';
import { runTrials, scoreTrials, type TrialAggregate, type TrialContext } from './trials';
import { EvaluatorInfrastructureError } from './verdict';

const CASE_ID = 'case-france';
const CASE_INPUT = 'What is the capital of France?';
const AGENT_USAGE = { prompt: 10, completion: 5, total: 15 };

function reply(content: string): ScriptedGenerateStep {
  return { kind: 'respond', response: { content, toolCalls: [], usage: AGENT_USAGE } };
}

/** One agent reply per trial. */
function agentScript(count: number): ScriptedGenerateStep[] {
  return Array.from({ length: count }, () => reply('Paris, on the Seine.'));
}

/**
 * Scorers that answer trial by trial: the assertion returns `holds[n]` and the
 * heuristic `heuristic[n]` on its nth call, and hold or score 1 past the end.
 */
function scorers(options: { holds?: readonly boolean[]; heuristic?: readonly number[] } = {}) {
  let assertionCalls = 0;
  let heuristicCalls = 0;
  const bound: CriterionScorers = {
    assertions: { 'names-the-capital': () => options.holds?.[assertionCalls++] ?? true },
    heuristics: { concise: () => options.heuristic?.[heuristicCalls++] ?? 1 },
    policies: { 'follows-style-guide': () => true },
  };
  return bound;
}

async function modelEvaluator(
  judgeReplies: readonly string[],
  options: { holds?: readonly boolean[]; configuration?: Record<string, unknown> } = {},
): Promise<Evaluator> {
  return createEvaluator({
    configuration: options.configuration ?? modelConfigurationInput(),
    dataset: datasetInput(),
    scorers: scorers(options),
    generate: createScriptedGenerate(judgeReplies.map((content) => reply(content))),
  });
}

function scriptedAgent(count: number) {
  return createAgent({ name: 'geographer', generate: createScriptedGenerate(agentScript(count)) });
}

function expectedSeeds(randomSeed: string, count: number): number[] {
  const runtime = createManualRuntimeServices({ randomSeed });
  return Array.from({ length: count }, () => Math.floor(runtime.random.next() * 0x1_0000_0000));
}

/** A hand-built operative agent whose runs resolve with, or reject with, what `outcome` returns. */
function stubAgent(
  outcome: (input: string) => Promise<RunResultBase>,
): RunnableAgent<unknown, boolean> {
  return {
    name: 'stub',
    hasOutput: false,
    run: (input) => {
      const result = outcome(input as string);
      return { result: () => result } as unknown as AgentRun<unknown, boolean>;
    },
  };
}

describe('runTrials', () => {
  test('invokes the subject agent’s run() exactly repetitions times, with the case input and a recorded seed', async () => {
    const agent = scriptedAgent(3);
    const run = spyOn(agent, 'run');
    const contexts: TrialContext[] = [];
    const aggregate = await runTrials({
      evaluator: await modelEvaluator([judgeReply(), judgeReply(), judgeReply()]),
      caseId: CASE_ID,
      subject: (context) => {
        contexts.push(context);
        return agent;
      },
      runtime: createManualRuntimeServices({ randomSeed: 'trial-seeds' }),
    });

    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.map(([input]) => input)).toEqual([CASE_INPUT, CASE_INPUT, CASE_INPUT]);
    const seeds = expectedSeeds('trial-seeds', 3);
    expect(contexts).toEqual(seeds.map((seed, index) => ({ trial: index + 1, seed })));
    expect(aggregate.trials.map((trial) => trial.seed)).toEqual(seeds);
    expect(aggregate.outcome).toBe('pass');
    expect(aggregate.repetitions).toBe(3);
    expect(aggregate.caseId).toBe(CASE_ID);
    expect(aggregate.datasetVersion).toBe('capitals-2026-09');
    expect(aggregate.codeRevision).toBe('a7679370f3e1a3b850299d13c9e768541a601722');
    expect(aggregate.variancePolicy?.name).toBe('two-of-three');
  });

  test('records each trial’s seed, finish reason, per-criterion results, usage, and feedback', async () => {
    const aggregate = await runTrials({
      evaluator: await modelEvaluator([judgeReply(), judgeReply(), judgeReply()]),
      caseId: CASE_ID,
      subject: () => scriptedAgent(1),
      runtime: createManualRuntimeServices(),
    });
    const [first] = aggregate.trials;
    expect(first).toMatchObject({
      trial: 1,
      verdict: 'pass',
      finishReason: 'stop-condition',
      usage: AGENT_USAGE,
      feedback: 'Clear, direct answer.',
    });
    expect(first?.criteria.map((criterion) => [criterion.name, criterion.score])).toEqual([
      ['names-the-capital', 1],
      ['concise', 1],
      ['no-web-search', 1],
      ['follows-style-guide', 1],
      ['helpful-tone', 1],
    ]);
    expect(first?.weightedTotal).toBe(1);
    expect(first).not.toHaveProperty('costEstimate');
    expect(first).not.toHaveProperty('error');
  });

  test('reproduces a byte-identical aggregate report from the recorded seeds and the same scripts', async () => {
    async function trialRun(
      randomSeed: string,
      seeds?: readonly number[],
    ): Promise<TrialAggregate> {
      const agentGenerate = createScriptedGenerate(agentScript(3));
      return runTrials({
        evaluator: await modelEvaluator([judgeReply(), judgeReply({ score: 0.5 }), judgeReply()]),
        caseId: CASE_ID,
        subject: ({ seed }) =>
          createAgent({
            name: 'geographer',
            generate: agentGenerate,
            runtime: createManualRuntimeServices({
              randomSeed: String(seed),
              identifierSeed: String(seed),
            }),
          }),
        runtime: createManualRuntimeServices({ randomSeed }),
        seeds,
      });
    }

    const recorded = await trialRun('first-run');
    const replayed = await trialRun(
      'a-different-draw',
      recorded.trials.map((trial) => trial.seed),
    );
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(recorded));

    const redrawn = await trialRun('a-different-draw');
    expect(redrawn.trials.map((trial) => trial.seed)).not.toEqual(
      recorded.trials.map((trial) => trial.seed),
    );
    expect(JSON.stringify(redrawn)).not.toBe(JSON.stringify(recorded));
  });

  test('reports per-criterion statistics that match the committed ten-trial fixture', async () => {
    const configuration = deterministicConfigurationInput();
    configuration['repetitions'] = 10;
    expect(configuration['passThreshold']).toBe(tenTrialScores.threshold);
    const aggregate = await runTrials({
      evaluator: await createEvaluator({
        configuration,
        dataset: datasetInput(),
        scorers: scorers({ heuristic: tenTrialScores.scores }),
      }),
      caseId: CASE_ID,
      subject: () => scriptedAgent(1),
      runtime: createManualRuntimeServices(),
    });

    const concise = aggregate.statistics.criteria.find((criterion) => criterion.name === 'concise');
    const { expected } = tenTrialScores;
    expect(concise?.trials).toBe(expected.trials);
    expect(concise?.passes).toBe(expected.passes);
    const actual: Record<string, number | null | undefined> = {
      passFraction: concise?.passFraction,
      meanScore: concise?.meanScore,
      sampleVariance: concise?.sampleVariance,
      standardDeviation: concise?.standardDeviation,
      lower: concise?.wilsonInterval?.lower,
      upper: concise?.wilsonInterval?.upper,
      width: concise?.wilsonInterval?.width,
    };
    const wanted: Record<string, number> = {
      passFraction: expected.passFraction,
      meanScore: expected.meanScore,
      sampleVariance: expected.sampleVariance,
      standardDeviation: expected.standardDeviation,
      ...expected.wilsonInterval,
    };
    for (const [statistic, value] of Object.entries(wanted)) {
      expect(Math.abs((actual[statistic] as number) - value)).toBeLessThanOrEqual(1e-9);
    }
    expect(aggregate.statistics.criteria.map((criterion) => criterion.name)).toEqual([
      'names-the-capital',
      'concise',
      'no-web-search',
      'follows-style-guide',
    ]);
    expect(aggregate.statistics.verdicts).toMatchObject({
      trials: 10,
      passes: 10,
      passFraction: 1,
    });
    expect(aggregate.outcome).toBe('pass');
    expect(aggregate.variancePolicy).toBeNull();
  });

  test('yields disagreement when verdicts split below the minimum pass fraction, with no collapsed pass boolean', async () => {
    const aggregate = await runTrials({
      evaluator: await modelEvaluator([judgeReply(), judgeReply(), judgeReply()], {
        holds: [true, false, false],
      }),
      caseId: CASE_ID,
      subject: () => scriptedAgent(1),
      runtime: createManualRuntimeServices(),
    });

    expect(aggregate.outcome).toBe('disagreement');
    if (aggregate.outcome !== 'disagreement') throw new Error('Expected disagreement');
    expect(aggregate.disagreement).toEqual({
      reasons: ['below-minimum-pass-fraction'],
      breakdown: [
        { trial: 1, verdict: 'pass' },
        { trial: 2, verdict: 'fail' },
        { trial: 3, verdict: 'fail' },
      ],
    });
    for (const collapsed of ['pass', 'passed', 'verdict']) {
      expect(aggregate).not.toHaveProperty(collapsed);
    }
    expect(aggregate.statistics.verdicts).toMatchObject({ trials: 3, passes: 1 });
    const namesTheCapital = aggregate.statistics.criteria[0];
    expect(namesTheCapital).toMatchObject({
      name: 'names-the-capital',
      passes: 1,
      meanScore: 1 / 3,
    });
  });

  test('yields disagreement when a split’s interval is wider than the policy allows', async () => {
    const configuration = modelConfigurationInput();
    configuration['variancePolicy'] = {
      name: 'narrow',
      version: '1',
      minimumPassFraction: 0.6,
      maximumIntervalWidth: 0.7,
    };
    const aggregate = await runTrials({
      evaluator: await modelEvaluator([judgeReply(), judgeReply(), judgeReply()], {
        holds: [true, true, false],
        configuration,
      }),
      caseId: CASE_ID,
      subject: () => scriptedAgent(1),
      runtime: createManualRuntimeServices(),
    });
    expect(aggregate.outcome).toBe('disagreement');
    if (aggregate.outcome !== 'disagreement') throw new Error('Expected disagreement');
    expect(aggregate.disagreement.reasons).toEqual(['interval-too-wide']);
  });

  test('fails a case whose every trial fails', async () => {
    const aggregate = await runTrials({
      evaluator: await modelEvaluator([judgeReply(), judgeReply(), judgeReply()], {
        holds: [false, false, false],
      }),
      caseId: CASE_ID,
      subject: () => scriptedAgent(1),
      runtime: createManualRuntimeServices(),
    });
    expect(aggregate.outcome).toBe('fail');
  });

  test('one infrastructure failure among passing trials makes the aggregate indeterminate, with no hidden retry', async () => {
    const agent = scriptedAgent(3);
    const run = spyOn(agent, 'run');
    const judge = createScriptedGenerate([
      reply(judgeReply()),
      reply('not json'),
      reply(judgeReply()),
    ]);
    const aggregate = await runTrials({
      evaluator: await createEvaluator({
        configuration: modelConfigurationInput(),
        dataset: datasetInput(),
        scorers: scorers(),
        generate: judge,
      }),
      caseId: CASE_ID,
      subject: () => agent,
      runtime: createManualRuntimeServices(),
    });

    expect(run).toHaveBeenCalledTimes(3);
    expect(judge.callCount).toBe(3);
    expect(aggregate.outcome).toBe('indeterminate');
    if (aggregate.outcome !== 'indeterminate') throw new Error('Expected indeterminate');
    expect(aggregate.errors).toHaveLength(1);
    expect(aggregate.errors[0]).toBeInstanceOf(EvaluatorInfrastructureError);
    expect(aggregate.errors[0]?.reason).toBe('judge-malformed-output');
    expect(aggregate.trials.map((trial) => trial.verdict)).toEqual([
      'pass',
      'infrastructure-failure',
      'pass',
    ]);
    expect(aggregate.trials[1]?.error).toBe(aggregate.errors[0]);
    expect(aggregate.trials[1]?.criteria).toEqual([]);
    expect(aggregate.statistics.verdicts).toMatchObject({ trials: 2, passes: 2 });
    expect(aggregate).not.toHaveProperty('pass');
    const serialized = JSON.parse(JSON.stringify(aggregate)) as { errors: unknown[] };
    expect(serialized.errors).toEqual([
      {
        name: 'EvaluatorInfrastructureError',
        reason: 'judge-malformed-output',
        message: 'Model judge "rubric-judge" returned malformed output: the reply is not JSON',
      },
    ]);
  });

  test('types a trial whose run rejects, or whose agent cannot be built, as a subject error and runs every trial', async () => {
    const rejection = new Error('terminal session commit missing');
    const built = new Error('agent factory exploded');
    const calls: number[] = [];
    const aggregate = await runTrials({
      evaluator: await createEvaluator({
        configuration: deterministicConfigurationInput(),
        dataset: datasetInput(),
        scorers: scorers(),
      }),
      caseId: CASE_ID,
      subject: ({ trial }) => {
        calls.push(trial);
        if (trial === 1) throw built;
        return stubAgent(async () => {
          throw rejection;
        });
      },
      runtime: createManualRuntimeServices(),
      seeds: [7],
    });
    expect(calls).toEqual([1]);
    expect(aggregate.outcome).toBe('indeterminate');
    if (aggregate.outcome !== 'indeterminate') throw new Error('Expected indeterminate');
    expect(aggregate.errors[0]).toMatchObject({ reason: 'subject-error', cause: built });
    expect(aggregate.trials[0]).toEqual({
      trial: 1,
      seed: 7,
      verdict: 'infrastructure-failure',
      criteria: [],
      error: aggregate.errors[0]!,
    });

    const configuration = deterministicConfigurationInput();
    configuration['repetitions'] = 2;
    const rejected = await runTrials({
      evaluator: await createEvaluator({
        configuration,
        dataset: datasetInput(),
        scorers: scorers(),
      }),
      caseId: CASE_ID,
      subject: ({ trial }) =>
        stubAgent(async () => {
          if (trial === 1) throw rejection;
          return runResult();
        }),
      runtime: createManualRuntimeServices(),
    });
    expect(rejected.trials.map((trial) => trial.verdict)).toEqual([
      'infrastructure-failure',
      'pass',
    ]);
    expect(rejected.trials[0]?.error).toMatchObject({ reason: 'subject-error', cause: rejection });
    expect(rejected.trials[0]?.error?.message).toBe(
      'Trial 1 of case "case-france" did not produce a run result',
    );
  });

  test('records the cost estimate a run reports and counts agent failures against the pass fraction', async () => {
    const costEstimate = {
      promptCost: 0.01,
      completionCost: 0.02,
      cacheWriteCost: 0,
      cacheReadCost: 0,
      totalCost: 0.03,
      model: 'claude-sonnet-4-5',
      usage: { prompt: 12, completion: 8, total: 20 },
    };
    const configuration = deterministicConfigurationInput();
    configuration['repetitions'] = 2;
    const aggregate = await runTrials({
      evaluator: await createEvaluator({
        configuration,
        dataset: datasetInput(),
        scorers: scorers(),
      }),
      caseId: CASE_ID,
      subject: ({ trial }) =>
        stubAgent(async () => ({
          ...runResult({ finishReason: trial === 1 ? 'stop-condition' : 'maximum-steps' }),
          costEstimate,
        })),
      runtime: createManualRuntimeServices(),
    });
    expect(aggregate.trials[0]?.costEstimate).toEqual(costEstimate);
    expect(aggregate.trials[1]).toMatchObject({
      verdict: 'agent-failed',
      finishReason: 'maximum-steps',
      criteria: [],
      costEstimate,
    });
    expect(aggregate.trials[1]).not.toHaveProperty('weightedTotal');
    expect(aggregate.statistics.verdicts).toMatchObject({
      trials: 2,
      passes: 1,
      passFraction: 0.5,
    });
    expect(aggregate.statistics.criteria[0]).toMatchObject({ trials: 1, sampleVariance: null });
    expect(aggregate.outcome).toBe('disagreement');
  });

  test('rejects an unknown case before running any trial', async () => {
    const agent = scriptedAgent(1);
    const run = spyOn(agent, 'run');
    const evaluator = await modelEvaluator([]);
    expect(
      await throwingRejectionOf(
        runTrials({
          evaluator,
          caseId: 'case-mars',
          subject: () => agent,
          runtime: createManualRuntimeServices(),
        }),
      ),
    ).toThrow('Unknown evaluation case "case-mars"');
    expect(run).toHaveBeenCalledTimes(0);
  });

  test.each<[string, readonly number[]]>([
    ['too few seeds', [1, 2]],
    ['too many seeds', [1, 2, 3, 4]],
    ['a negative seed', [1, -2, 3]],
    ['a fractional seed', [1, 2.5, 3]],
    ['a seed beyond 32 bits', [1, 2, 0x1_0000_0000]],
  ])('rejects %s before running any trial', async (_label, seeds) => {
    const agent = scriptedAgent(3);
    const run = spyOn(agent, 'run');
    expect(
      await throwingRejectionOf(
        runTrials({
          evaluator: await modelEvaluator([]),
          caseId: CASE_ID,
          subject: () => agent,
          runtime: createManualRuntimeServices(),
          seeds,
        }),
      ),
    ).toThrow(RangeError);
    expect(run).toHaveBeenCalledTimes(0);
  });

  test('draws seeds from the real runtime services by default', async () => {
    const aggregate = await runTrials({
      evaluator: await modelEvaluator([judgeReply(), judgeReply(), judgeReply()]),
      caseId: CASE_ID,
      subject: () => scriptedAgent(1),
    });
    for (const { seed } of aggregate.trials) {
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(0x1_0000_0000);
    }
  });
});

describe('scoreTrials', () => {
  test('scores the run each trial’s producer returns, with the case input, under the given seeds', async () => {
    const produced: [TrialContext, string][] = [];
    const aggregate = await scoreTrials({
      evaluator: await modelEvaluator([judgeReply(), judgeReply(), judgeReply()]),
      caseId: CASE_ID,
      runResult: (context, input) => {
        produced.push([context, input]);
        return Promise.resolve(runResult());
      },
      seeds: [7, 8, 9],
    });

    expect(produced).toEqual([
      [{ trial: 1, seed: 7 }, CASE_INPUT],
      [{ trial: 2, seed: 8 }, CASE_INPUT],
      [{ trial: 3, seed: 9 }, CASE_INPUT],
    ]);
    expect(aggregate.outcome).toBe('pass');
    expect(aggregate.trials.map((trial) => trial.seed)).toEqual([7, 8, 9]);
  });

  test('types a producer that rejects or throws as that trial’s subject error', async () => {
    let calls = 0;
    const aggregate = await scoreTrials({
      evaluator: await modelEvaluator([judgeReply()]),
      caseId: CASE_ID,
      runResult: () => {
        calls += 1;
        if (calls === 1) throw new Error('no recorded run');
        if (calls === 2) return Promise.reject(new Error('no recorded run'));
        return Promise.resolve(runResult());
      },
      runtime: createManualRuntimeServices(),
    });

    expect(aggregate.outcome).toBe('indeterminate');
    expect(aggregate.trials.map((trial) => trial.error?.reason)).toEqual([
      'subject-error',
      'subject-error',
      undefined,
    ]);
  });
});
