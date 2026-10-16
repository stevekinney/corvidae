import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  comparisonEvidenceDigest,
  verifyComparisonEvidence,
  type ComparisonEvidence,
} from '../src/comparison-evidence';
import { renderComparisonReport } from '../src/comparison-report';
import { fullyConnectedPlanInput } from '../src/fixtures/comparison/plans';
import { admissionRuleInput } from '../src/fixtures/comparison/rules';
import { vaultCodeScenario } from '../src/fixtures/comparison/scenarios';
import { DEFAULT_SUITES_DIRECTORY, runComparisonCommand } from './comparison';

const PACKAGE_DIRECTORY = join(import.meta.dir, '..');

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'comparison-command-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  args: readonly string[],
  options: Omit<NonNullable<Parameters<typeof runComparisonCommand>[1]>, 'output'> = {},
): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runComparisonCommand(args, {
    ...options,
    output: {
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
    },
  });
  return { exitCode, stdout, stderr };
}

/** Runs the package's `comparison` script in its own `bun` process through the `--cwd` form. */
async function spawnComparison(...args: string[]): Promise<CommandResult> {
  const child = Bun.spawn(
    [process.execPath, 'run', '--cwd', PACKAGE_DIRECTORY, 'comparison', ...args],
    { timeout: 120_000, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Writes `suites/<id>.json` naming `module`, and returns the suites directory. */
async function suiteFile(id: string, contents: unknown): Promise<string> {
  const suites = join(directory, 'suites');
  await mkdir(suites, { recursive: true });
  await writeFile(
    join(suites, `${id}.json`),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
  return suites;
}

function failure(result: CommandResult): { decision: string; exitCode: number; issues: string[] } {
  return JSON.parse(result.stdout) as { decision: string; exitCode: number; issues: string[] };
}

/** The admission fixtures: each suite's exit code, admission decision, and stderr summary. */
const FIXTURE_SUITES = [
  ['fixture-vault-code', 0, 'admit'],
  ['fixture-negative-control', 1, 'reject'],
  ['fixture-ungoverned-scratchpad', 1, 'reject'],
] as const;

// The real process is the behavior under test (script wiring, stdout, stderr and exit code), so it
// runs once here at module scope to stay off the per-test clock.
const spawnedVaultCode = await spawnComparison('--suite', 'fixture-vault-code');

/**
 * The one test that boots a real `bun` process: it proves the `comparison`
 * script is wired to the entry point and that stdout, stderr and the process
 * exit code carry the command's result. Every suite's exit code and evidence is
 * asserted in process below, so nothing else here pays for a spawn inside the
 * per-test budget.
 */
describe('comparison (spawned bun process, --cwd form)', () => {
  test('fixture-vault-code exits 0: admit', async () => {
    const result = await spawnedVaultCode;
    expect(result.exitCode).toBe(0);
    const evidence = await verifyComparisonEvidence(JSON.parse(result.stdout));
    expect(evidence.admission.decision).toBe('admit');
    expect(result.stderr).toContain('comparison: admit (exit 0)');
  });
});

describe('runComparisonCommand', () => {
  test.each(FIXTURE_SUITES)('%s exits %d: %s', async (suite, exitCode, decision) => {
    const result = await run(['--suite', suite]);
    expect(result.exitCode).toBe(exitCode);
    const evidence = await verifyComparisonEvidence(JSON.parse(result.stdout));
    expect(evidence.admission.decision).toBe(decision);
    expect(result.stderr).toContain(`comparison: ${decision} (exit ${exitCode})`);
  });

  test('is reproducible: two runs from the same recorded seeds print identical evidence', async () => {
    const first = await run(['--suite', 'fixture-vault-code']);
    const second = await run(['--suite', 'fixture-vault-code']);
    expect(second.stdout).toBe(first.stdout);
  });

  test('prints one evidence document, writes the report beside it, and summarizes on stderr', async () => {
    const report = join(directory, 'reports', 'vault-code.md');
    const result = await run(['--suite', 'fixture-vault-code', '--report', report]);
    expect(result.exitCode).toBe(0);
    const evidence = await verifyComparisonEvidence(JSON.parse(result.stdout));
    const digest = await comparisonEvidenceDigest(evidence);
    expect(await readFile(report, 'utf8')).toBe(`${renderComparisonReport(evidence, digest)}\n`);
    // The suite's manual clock: 27 scripted turns of 250 ms after its origin.
    expect(evidence.recordedAt).toBe('2026-09-28T00:00:06.750Z');
    expect(result.stderr).toBe(
      [
        `evidence ${evidence.id} (digest ${digest})`,
        `report written to ${report}`,
        'comparison: admit (exit 0)',
        '',
      ].join('\n'),
    );
  });

  test('lists each finding on stderr when admission is refused', async () => {
    const result = await run(['--suite', 'fixture-negative-control']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      '  quality, insufficient-success-gain: Collaboration task success 0.0000 against the better control 1.0000',
    );
  });

  test('replays the seeds recorded in earlier evidence', async () => {
    const first = await run(['--suite', 'fixture-vault-code']);
    const recorded = join(directory, 'evidence.json');
    await writeFile(recorded, first.stdout);
    const reseeded = async () => {
      const scenario = await vaultCodeScenario();
      return { ...scenario, runtime: { ...scenario.runtime, random: { next: () => 0.5 } } };
    };
    const replayed = await run(['--suite', 'fixture-vault-code', '--seeds', recorded], {
      loadSuite: async () => ({ default: reseeded }),
    });
    expect(replayed.stdout).toBe(first.stdout);
    const unseeded = await run(['--suite', 'fixture-vault-code'], {
      loadSuite: async () => ({ default: reseeded }),
    });
    expect(unseeded.stdout).not.toBe(first.stdout);
  });

  test('runs the suites directory it is given and defaults to the committed one', () => {
    expect(DEFAULT_SUITES_DIRECTORY).toBe(join(PACKAGE_DIRECTORY, 'comparisons'));
  });

  test.each<[string, string[]]>([
    ['no suite', []],
    ['an unknown option', ['--suite', 'fixture-vault-code', '--verbose']],
    ['a suite id that is a path', ['--suite', '../gates/fixture-regression']],
  ])('exits 64 for %s', async (_label, args) => {
    const result = await run(args);
    expect(result.exitCode).toBe(64);
    expect(failure(result)).toMatchObject({
      kind: 'collaboration-comparison-failure',
      decision: 'configuration-error',
      exitCode: 64,
    });
    expect(result.stderr).toContain('Usage: bun run --cwd testing/evaluation comparison');
  });

  test('exits 64 for a suite file that is missing, unreadable JSON, or incomplete', async () => {
    const missing = await run(['--suite', 'absent', '--suites-dir', directory]);
    expect(missing.exitCode).toBe(64);
    expect(failure(missing).issues[0]).toStartWith('Cannot read the suite file');

    const garbled = await run([
      '--suite',
      'garbled',
      '--suites-dir',
      await suiteFile('garbled', '{'),
    ]);
    expect(failure(garbled).issues[0]).toStartWith('Cannot read the suite file');

    const incomplete = await run([
      '--suite',
      'incomplete',
      '--suites-dir',
      await suiteFile('incomplete', { suite: '../vault-code.ts' }),
    ]);
    expect(failure(incomplete).issues).toEqual([
      'admissionRule: Invalid input: expected object, received undefined',
    ]);
  });

  test('exits 64 for a rule with a missing threshold, since no threshold has a default', async () => {
    const rule = admissionRuleInput();
    delete rule['quality'].minimumSuccessGain;
    const suites = await suiteFile('no-gain', { suite: 'suite.ts', admissionRule: rule });
    const result = await run(['--suite', 'no-gain', '--suites-dir', suites]);
    expect(failure(result).issues).toEqual([
      'admissionRule.quality.minimumSuccessGain: Invalid input: expected number, received undefined',
    ]);
  });

  test('exits 64 when the suite module cannot be loaded or builds no suite', async () => {
    const suites = await suiteFile('broken', {
      suite: 'nowhere.ts',
      admissionRule: admissionRuleInput(),
    });
    const missing = await run(['--suite', 'broken', '--suites-dir', suites]);
    expect(missing.exitCode).toBe(64);
    expect(failure(missing).issues[0]).toStartWith('Cannot load the suite module');

    const noDefault = await run(['--suite', 'broken', '--suites-dir', suites], {
      loadSuite: async () => ({}),
    });
    expect(failure(noDefault).issues).toEqual([
      'The suite module has no default export that builds a comparison suite',
    ]);

    const throws = await run(['--suite', 'broken', '--suites-dir', suites], {
      loadSuite: async () => ({
        default: () => {
          throw new Error('The suite could not be built');
        },
      }),
    });
    expect(failure(throws).issues).toEqual([
      'Cannot build the comparison suite: The suite could not be built',
    ]);
  });

  test('exits 64 for a comparison or admission that is misconfigured', async () => {
    const broken = async () => ({ ...(await vaultCodeScenario()), definition: {} });
    const result = await run(['--suite', 'fixture-vault-code'], {
      loadSuite: async () => ({ default: broken }),
    });
    expect(result.exitCode).toBe(64);
    expect(failure(result).issues).toContain(
      'definition.id: Invalid input: expected string, received undefined',
    );

    const suites = await suiteFile('wrong-class', {
      suite: join(PACKAGE_DIRECTORY, 'src', 'fixtures', 'comparison', 'vault-code.ts'),
      admissionRule: admissionRuleInput('shared-state'),
    });
    const mismatch = await run(['--suite', 'wrong-class', '--suites-dir', suites]);
    expect(failure(mismatch).issues).toEqual([
      'taskClass: The rule admits shared-state, but the comparison ran partitioned-search',
    ]);
  });

  test('exits 64 for a dense collaboration on its other issues, never its loops (COR-820 amendment row 17b)', async () => {
    const dense = async () => {
      const scenario = await vaultCodeScenario();
      return {
        ...scenario,
        plans: { ...scenario.plans, collaboration: fullyConnectedPlanInput(12) },
      };
    };
    const result = await run(['--suite', 'fixture-vault-code'], {
      loadSuite: async () => ({ default: dense }),
    });
    expect(result.exitCode).toBe(64);
    const { issues } = failure(result);
    expect(issues.length).toBeGreaterThan(0);
    expect(
      issues.filter((issue) => issue.startsWith('plans.collaboration.topology.edges')),
    ).toEqual([]);
  });

  test('exits 64 for recorded seeds it cannot read or trust', async () => {
    const garbled = join(directory, 'garbled.json');
    await writeFile(garbled, 'not json');
    const unreadable = await run(['--suite', 'fixture-vault-code', '--seeds', garbled]);
    expect(unreadable.exitCode).toBe(64);
    expect(failure(unreadable).issues[0]).toStartWith('Cannot read the recorded seeds');

    const first = await run(['--suite', 'fixture-vault-code']);
    const tampered = JSON.parse(first.stdout) as ComparisonEvidence & Record<string, unknown>;
    tampered.revision = '0'.repeat(64);
    const forged = join(directory, 'forged.json');
    await writeFile(forged, JSON.stringify(tampered));
    const refused = await run(['--suite', 'fixture-vault-code', '--seeds', forged]);
    expect(failure(refused).issues).toEqual([
      'revision: The evidence revision does not match its binding',
    ]);
  });

  test('exits 2 when the comparison machinery itself fails', async () => {
    const crashing = async () => {
      const scenario = await vaultCodeScenario();
      return { ...scenario, runtime: { ...scenario.runtime, random: undefined } };
    };
    const result = await run(['--suite', 'fixture-vault-code'], {
      loadSuite: async () => ({ default: crashing }),
    });
    expect(result.exitCode).toBe(2);
    expect(failure(result)).toMatchObject({ decision: 'infrastructure-failure', exitCode: 2 });
    expect(result.stderr).toContain('The comparison itself failed:');
  });
});
