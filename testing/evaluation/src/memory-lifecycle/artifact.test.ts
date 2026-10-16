import { describe, expect, test } from 'bun:test';

import { EvaluatorInfrastructureError } from '../verdict';
import {
  artifactDigest,
  MEMORY_LIFECYCLE_REPLAY_EXIT_CODES,
  observedTrace,
  replayScenarioArtifact,
  type ScenarioRunArtifact,
  scenarioRunArtifactSchema,
  summarizeEvaluation,
} from './artifact';
import { memoryLifecycleEnvelope } from './envelope';
import { baselineRunOf, scenarioOf, suiteRun } from './memory-lifecycle.test-support';
import { memoryLifecycleSuite } from './suite';

async function artifactOf(
  baseline: 'lifecycle' | 'flat-hybrid',
  scenarioId: string,
): Promise<ScenarioRunArtifact> {
  const run = await suiteRun();
  return structuredClone(
    baselineRunOf(run, baseline).artifacts.find((artifact) => artifact.scenario.id === scenarioId)!,
  );
}

/** `artifact` with `change` applied and its digest recomputed, as a careful forger would. */
async function resigned(
  artifact: ScenarioRunArtifact,
  change: (unsigned: Omit<ScenarioRunArtifact, 'digest'>) => void,
): Promise<ScenarioRunArtifact> {
  const { digest: _digest, ...unsigned } = structuredClone(artifact);
  change(unsigned);
  return { ...unsigned, digest: await artifactDigest(unsigned) };
}

describe('scenario run artifacts', () => {
  test('record every revision the issue names, and a digest that ignores host measurements', async () => {
    const artifact = await artifactOf('flat-hybrid', 'shared-agent-phone');
    expect(scenarioRunArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(Object.keys(artifact.revisions).toSorted()).toEqual([
      'effectiveContext',
      'environment',
      'evidence',
      'outcome',
      'provider',
      'retrievalPlan',
      'tools',
      'transitions',
    ]);
    expect(artifact).toMatchObject({
      id: 'deterministic.flat-hybrid.shared-agent-phone.1',
      baseline: { name: 'flat-hybrid', revision: 'flat-hybrid-1', components: [] },
      lane: 'deterministic',
      trial: 1,
      outcome: { verdict: 'fail', infrastructureFailure: null },
      environment: { state: { kind: 'acted', value: '206-555-0199' } },
    });
    const { digest, ...unsigned } = artifact;
    expect(
      await artifactDigest({ ...unsigned, measured: { wallClockMilliseconds: 123_456 } }),
    ).toBe(digest);
  });
});

describe('replayScenarioArtifact', () => {
  test('replays a failure without a model and matches its digest', async () => {
    const artifact = await artifactOf('flat-hybrid', 'shared-agent-phone');
    expect(await replayScenarioArtifact(artifact)).toEqual({
      result: 'match',
      artifactId: artifact.id,
      digest: artifact.digest,
    });
    expect(MEMORY_LIFECYCLE_REPLAY_EXIT_CODES.match).toBe(0);
  });

  test("replays an ablation's artifact with the components it names", async () => {
    const run = await suiteRun();
    const ablated = run.ablations.find((entry) => entry.component === 'procedure-memory')!.run;
    const artifact = ablated.artifacts.find(
      (entry) => entry.scenario.id === 'unverified-forum-procedure',
    )!;
    expect(artifact).toMatchObject({
      id: 'deterministic.lifecycle-without-procedure-memory.unverified-forum-procedure.1',
      baseline: { name: 'lifecycle', components: ['state-projector', 'resource-derivation'] },
    });
    expect(await replayScenarioArtifact(artifact)).toEqual({
      result: 'match',
      artifactId: artifact.id,
      digest: artifact.digest,
    });
  });

  test('replays with the components an artifact names, so a forged component list mismatches', async () => {
    const full = await artifactOf('lifecycle', 'unverified-forum-procedure');
    const ablated = await replayScenarioArtifact(
      await resigned(full, (unsigned) => {
        unsigned.baseline.components = ['state-projector', 'resource-derivation'];
      }),
    );
    expect(ablated.result).toBe('mismatch');
    if (ablated.result !== 'mismatch') return;
    const paths = ablated.differences.map((difference) => difference.path);
    // Replayed without procedure memory, the recall hands the model the forum post it withheld.
    expect(paths).toContain('id');
    expect(paths).toContain('effectiveContext.0.withheld');

    const claimed = await replayScenarioArtifact(
      await resigned(await artifactOf('flat-hybrid', 'shared-agent-phone'), (unsigned) => {
        unsigned.baseline.components = ['state-projector'];
      }),
    );
    expect(claimed).toMatchObject({
      result: 'mismatch',
      differences: [expect.objectContaining({ path: 'baseline.components.0' })],
    });
  });

  test('names every field a replay recomputes differently', async () => {
    const artifact = await artifactOf('lifecycle', 'pasted-email-injection');
    const forged = await resigned(artifact, (unsigned) => {
      const decide = unsigned.provider.exchanges[1]!.toolCalls[0]!;
      decide.arguments = { action: 'ship_order', value: '99 Harbor Road, Tacoma' };
    });
    const outcome = await replayScenarioArtifact(forged);
    expect(outcome.result).toBe('mismatch');
    if (outcome.result !== 'mismatch') return;
    const paths = outcome.differences.map((difference) => difference.path);
    expect(paths).toContain('environment.state.value');
    expect(paths).toContain('outcome.verdict');
    expect(paths).not.toContain('digest');
    expect(outcome.storedDigest).toBe(forged.digest);
    expect(MEMORY_LIFECYCLE_REPLAY_EXIT_CODES.mismatch).toBe(4);
  });

  test('refuses anything that is not an intact artifact', async () => {
    expect(await replayScenarioArtifact({ kind: 'evaluation-run' })).toMatchObject({
      result: 'corrupt-artifact',
    });
    const unknown = await resigned(await artifactOf('lifecycle', 'forgotten-phone'), (unsigned) => {
      (unsigned.baseline.components as string[]) = ['vector-cache'];
    });
    expect(await replayScenarioArtifact(unknown)).toMatchObject({ result: 'corrupt-artifact' });
    const artifact = await artifactOf('lifecycle', 'forgotten-phone');
    const tampered = structuredClone(artifact);
    tampered.seed += 1;
    expect(await replayScenarioArtifact(tampered)).toEqual({
      result: 'corrupt-artifact',
      problem: `Artifact "${artifact.id}" does not match its digest`,
    });
  });

  test('refuses to replay against a suite, scenario, baseline, or envelope it was not recorded with', async () => {
    const artifact = await artifactOf('lifecycle', 'forgotten-phone');
    const edited = memoryLifecycleSuite();
    edited.scenarios[0]!.title = 'Edited';
    expect(await replayScenarioArtifact(artifact, { suite: edited })).toMatchObject({
      result: 'unresolvable',
    });
    const problems = await Promise.all(
      [
        (unsigned: Omit<ScenarioRunArtifact, 'digest'>) => {
          unsigned.scenario.id = 'retired-scenario';
        },
        (unsigned: Omit<ScenarioRunArtifact, 'digest'>) => {
          unsigned.baseline.revision = 'lifecycle-0';
        },
        (unsigned: Omit<ScenarioRunArtifact, 'digest'>) => {
          unsigned.envelope.digest = '0'.repeat(64);
        },
      ].map(async (change) => replayScenarioArtifact(await resigned(artifact, change))),
    );
    expect(problems.map((outcome) => outcome.result)).toEqual([
      'unresolvable',
      'unresolvable',
      'unresolvable',
    ]);
    expect(problems.map((outcome) => ('problem' in outcome ? outcome.problem : ''))).toEqual([
      'The suite at hand has no scenario "retired-scenario" as recorded',
      'Baseline "lifecycle" is now revision lifecycle-1, not lifecycle-0',
      "The deterministic lane's envelope has changed since the artifact was recorded",
    ]);
  });
});

describe('summarizeEvaluation', () => {
  test('summarizes a run the agent failed, and one the evaluator could not score', () => {
    const base = { run: {}, evaluationCase: {}, configuration: {}, evaluator: {} } as never;
    expect(summarizeEvaluation({ ...(base as object), verdict: 'agent-failed' } as never)).toEqual({
      verdict: 'agent-failed',
      criteria: [],
      infrastructureFailure: null,
    });
    const error = new EvaluatorInfrastructureError({ reason: 'scorer-error', message: 'broke' });
    expect(
      summarizeEvaluation({
        ...(base as object),
        verdict: 'infrastructure-failure',
        error,
      } as never),
    ).toEqual({
      verdict: 'infrastructure-failure',
      criteria: [],
      infrastructureFailure: 'scorer-error',
    });
  });
});

describe('observedTrace', () => {
  test('re-derives the trace of a run whose model never recalled', async () => {
    const scenario = scenarioOf('forgotten-phone');
    const trace = await observedTrace(
      { trace: undefined, recalls: [], exchanges: [], environment: { kind: 'untouched' } },
      scenario,
      'raw-log-search',
      memoryLifecycleEnvelope('deterministic'),
    );
    expect(trace.deletions).toEqual([
      { evidenceId: 'phone', status: 'completed', receipted: false },
    ]);
  });
});
