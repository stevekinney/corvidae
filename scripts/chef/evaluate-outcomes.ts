#!/usr/bin/env bun
/** Grades frozen SDLC pilot outcomes without launching provider sessions. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  materializeTask,
  verifyTaskBank,
  verifyTaskBankProvenance,
  type TaskBank,
  type TaskSnapshot,
} from './outcome-accounting.ts';
import { parseOptions, requireOption, UsageError } from './process-runner.ts';
import { digest } from './verification-plan.ts';

const providers = ['codex', 'claude-code'] as const;
const routes = ['current', 'simplified'] as const;
const usageFields = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output', 'calls'] as const;

type RecordValue = Record<string, unknown>;
type Usage = Record<(typeof usageFields)[number], number>;
type Trial = {
  task: string;
  provider: (typeof providers)[number];
  route: (typeof routes)[number];
  profile: string | null;
  snapshot: string;
  files: Record<string, string>;
  usage: Usage | null;
  cost: number | null;
  verificationMilliseconds: number | null;
  interventions: string[];
  exit: number;
};

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new UsageError(`${label} must be an object`);
  return value as RecordValue;
}

function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readUsage(value: unknown): Usage | null {
  if (value === null) return null;
  const usage = record(value, 'usage');
  for (const key of usageFields) {
    if (!natural(usage[key])) throw new UsageError(`usage.${key} must be a nonnegative integer`);
  }
  return usage as Usage;
}

function readTrial(value: unknown): Trial {
  const entry = record(value, 'trial');
  const {
    task,
    provider,
    route,
    profile,
    snapshot,
    cost,
    verificationMilliseconds,
    interventions,
    exit,
  } = entry;
  if (
    typeof task !== 'string' ||
    (provider !== 'codex' && provider !== 'claude-code') ||
    (route !== 'current' && route !== 'simplified') ||
    (profile !== null && (typeof profile !== 'string' || profile.trim() === '')) ||
    typeof snapshot !== 'string' ||
    !/^[0-9a-f]{64}$/.test(snapshot) ||
    !(cost === null || (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)) ||
    !(verificationMilliseconds === null || natural(verificationMilliseconds)) ||
    !Array.isArray(interventions) ||
    interventions.some((item) => typeof item !== 'string') ||
    !natural(exit)
  )
    throw new UsageError('invalid trial identity, outcome, or accounting');
  const files = record(entry['files'], 'trial files');
  if (Object.values(files).some((content) => typeof content !== 'string'))
    throw new UsageError('trial files must contain source strings');
  return {
    task,
    provider,
    route,
    profile,
    snapshot,
    files: files as Record<string, string>,
    usage: readUsage(entry['usage']),
    cost,
    verificationMilliseconds,
    interventions,
    exit,
  };
}

function snapshotOf(task: TaskSnapshot): string {
  return digest(
    JSON.stringify(
      Object.entries(task.files).toSorted(([left], [right]) => left.localeCompare(right, 'en')),
    ),
  );
}

function trialKey(trial: Pick<Trial, 'task' | 'provider' | 'route'>): string {
  return `${trial.task}:${trial.provider}:${trial.route}`;
}

function grade(task: TaskSnapshot, trial: Trial) {
  if (trial.snapshot !== snapshotOf(task))
    throw new UsageError(`${trialKey(trial)} used an unexpected snapshot`);
  const files = Object.entries(trial.files);
  if (files.some(([path]) => !task.permittedPaths.includes(path)))
    throw new UsageError(`${trialKey(trial)} changed a path outside the frozen task`);
  const scratch = mkdtempSync(join(tmpdir(), 'sdlc-outcome-'));
  try {
    const root = materializeTask(task, scratch, 'buggy');
    for (const [path, value] of files) writeFileSync(join(root, path), value);
    const oracle = Bun.spawnSync(['bun', ...task.oracleArgv], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      ...trial,
      files: files.map(([path]) => path),
      oracleExit: oracle.exitCode,
      accepted: trial.exit === 0 && oracle.exitCode === 0,
    };
  } finally {
    rmSync(scratch, { recursive: true });
  }
}

export function evaluateOutcomes(bank: TaskBank, results: unknown) {
  const errors = [...verifyTaskBank(bank), ...verifyTaskBankProvenance(bank)];
  if (errors.length > 0) throw new UsageError(errors.join('\n'));
  const input = record(results, 'pilot results');
  if (
    input['seed'] !== bank.orderSeed ||
    typeof input['complete'] !== 'boolean' ||
    !Array.isArray(input['trials'])
  )
    throw new UsageError('pilot results must identify the frozen seed, completeness, and trials');
  const tasks = bank.tasks.filter(
    ({ heldOut, family }) =>
      heldOut && (family === 'local-regression' || family === 'cross-workspace-contract'),
  );
  const expected = tasks.flatMap(({ id }) =>
    providers.flatMap((provider) => routes.map((route) => trialKey({ task: id, provider, route }))),
  );
  const seededOrder = expected.toSorted((left, right) => {
    const seeded = (key: string) => digest([bank.orderSeed, ...key.split(':')].join('\0'));
    return seeded(left).localeCompare(seeded(right), 'en');
  });
  const [first] = seededOrder;
  const firstPair = first?.split(':').slice(0, 2).join(':');
  const ordered = [
    ...seededOrder.filter((key) => key.startsWith(`${firstPair ?? ''}:`)),
    ...seededOrder.filter((key) => !key.startsWith(`${firstPair ?? ''}:`)),
  ];
  const trials = input['trials'].map(readTrial);
  const keys = new Set<string>();
  for (const trial of trials) {
    const key = trialKey(trial);
    if (!expected.includes(key) || keys.has(key))
      throw new UsageError(`unexpected or duplicate trial ${key}`);
    keys.add(key);
  }
  if (trials.some((trial, index) => trialKey(trial) !== ordered[index]))
    throw new UsageError('recorded trial order does not match the frozen seed');
  const missing = expected.filter((key) => !keys.has(key));
  if (input['complete'] && missing.length > 0)
    throw new UsageError(`claimed complete pilot is missing ${missing.join(', ')}`);
  const graded = trials.map((trial) =>
    grade(
      tasks.find(({ id }) => id === trial.task)!,
      trial,
    ),
  );
  const pairs = tasks.flatMap(({ id }) =>
    providers.map((provider) => {
      const [current, simplified] = routes.map((route) =>
        graded.find((trial) => trialKey(trial) === trialKey({ task: id, provider, route })),
      );
      const comparable =
        current?.accepted === true &&
        simplified?.accepted === true &&
        current.profile !== null &&
        current.profile === simplified.profile &&
        current.usage !== null &&
        simplified.usage !== null;
      return {
        task: id,
        provider,
        comparable,
        current: current ?? null,
        simplified: simplified ?? null,
      };
    }),
  );
  const aggregate = Object.entries(
    Object.groupBy(graded, (trial) => JSON.stringify([trial.provider, trial.profile, trial.route])),
  ).map(([group, members]) => {
    const attempts = members ?? [];
    const accepted = attempts.filter((trial) => trial.accepted).length;
    const totalTokens = attempts.reduce(
      (sum, trial) =>
        sum +
        (trial.usage === null
          ? 0
          : trial.usage.uncachedInput +
            trial.usage.cacheRead +
            trial.usage.cacheWrite +
            trial.usage.output),
      0,
    );
    const allUsageKnown = attempts.every((trial) => trial.usage !== null);
    const allCostsKnown = attempts.every((trial) => trial.cost !== null);
    const knownCost = attempts.reduce((sum, trial) => sum + (trial.cost ?? 0), 0);
    return {
      group: JSON.parse(group) as [string, string | null, string],
      attempts: attempts.length,
      accepted,
      failed: attempts.length - accepted,
      tokensPerAccepted: allUsageKnown && accepted > 0 ? totalTokens / accepted : null,
      costPerAccepted: allCostsKnown && accepted > 0 ? knownCost / accepted : null,
      knownCost,
      interventions: attempts.reduce((sum, trial) => sum + trial.interventions.length, 0),
    };
  });
  return {
    seed: bank.orderSeed,
    complete: input['complete'],
    missing,
    trialCount: graded.length,
    pairs,
    aggregate,
  };
}

if (import.meta.main) {
  try {
    const parsed = parseOptions(Bun.argv.slice(2), {
      values: ['manifest', 'results'],
      flags: ['json'],
    });
    if (parsed.positionals.length) throw new UsageError('Unexpected outcome argument');
    const bank = (await Bun.file(requireOption(parsed, 'manifest')).json()) as TaskBank;
    const results: unknown = await Bun.file(requireOption(parsed, 'results')).json();
    console.log(
      JSON.stringify(evaluateOutcomes(bank, results), null, parsed.flags.has('json') ? 0 : 2),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
