import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitUntil } from '../../testing/testing/src/wait-until.ts';
import { activeStep, executeStep, interruptActiveStep } from './focused-checks.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A step that starts a grandchild, records its pid, and then waits on it. */
function stepWithGrandchild(file: string): string[] {
  return ['sh', '-c', `sleep 600 & echo $! > ${file}; wait`];
}

async function grandchildPid(file: string): Promise<number> {
  const read = async () => {
    const text = (await Bun.file(file).exists()) ? await readFile(file, 'utf8') : '';
    return text.trim();
  };
  await waitUntil(async () => (await read()) !== '');
  return Number(await read());
}

// The real processes run at module scope, so their boot is not on the per-test clock.

const hangDirectory = await mkdtemp(join(tmpdir(), 'focused-group-'));
const hangFile = join(hangDirectory, 'pid');
const hangEnded = executeStep(stepWithGrandchild(hangFile), hangDirectory, false, 500);
const hangPid = await grandchildPid(hangFile);
const hangResult = await hangEnded;
await waitUntil(() => !alive(hangPid));

const exitDirectory = await mkdtemp(join(tmpdir(), 'focused-group-'));
const exitFile = join(exitDirectory, 'pid');
const exitCode = await executeStep(
  ['sh', '-c', `sleep 600 & echo $! > ${exitFile}`],
  exitDirectory,
  false,
);
const exitPid = await grandchildPid(exitFile);
await waitUntil(() => !alive(exitPid));

const interruptDirectory = await mkdtemp(join(tmpdir(), 'focused-group-'));
const interruptFile = join(interruptDirectory, 'pid');
activeStep.name = 'tests';
const interruptEnded = executeStep(stepWithGrandchild(interruptFile), interruptDirectory, false);
const interruptPid = await grandchildPid(interruptFile);
const interruptLines: string[] = [];
const interruptCode = await interruptActiveStep('SIGTERM', (line) => interruptLines.push(line));
const interruptResult = await interruptEnded;
await waitUntil(() => !alive(interruptPid));
activeStep.name = undefined;

for (const directory of [hangDirectory, exitDirectory, interruptDirectory])
  await rm(directory, { recursive: true, force: true });

describe('a focused-checks step runs in a process group', () => {
  test('the hang guard ends the step and the grandchild it started', () => {
    expect(hangResult).toEqual({ hung: true });
    expect(alive(hangPid)).toBe(false);
  });

  test('a step that exits leaves no grandchild behind', () => {
    expect(exitCode).toBe(0);
    expect(alive(exitPid)).toBe(false);
  });

  test('an interruption names the step, ends its group and takes the signal exit code', () => {
    expect(interruptCode).toBe(143);
    expect(interruptLines).toEqual(['focused-checks: interrupted by SIGTERM during step tests']);
    expect(interruptResult).toMatchObject({ signal: 'SIGTERM' });
    expect(alive(interruptPid)).toBe(false);
  });
});
