/**
 * A frozen process is not a hung one (COR-1541). This freezes a real scenario and its child past
 * their hang guards with SIGSTOP, the way a sleeping host freezes a test run, then resumes them.
 * Bun's timers count the frozen time, so before the awake-time guard the scenario was reported
 * hung and its child was SIGTERMed on resume, although neither had used its budget.
 *
 * The scenario runs in a child Bun process so that this file's own clock keeps running. It
 * guards a grandchild (`sh` waiting on its stdin) for 3 s of awake time, and a timer due 4 s
 * after it starts releases the grandchild. The freeze lasts 5 s, so that timer is due the moment
 * the scenario resumes: the grandchild has finished nothing before the freeze and needs nothing
 * but that release after it. Freezing starts as soon as the scenario reports ready, so the time
 * it lives through stays far below its 3 s guard even on a loaded host.
 */
import { expect, it } from 'bun:test';

import { spawnWithHangGuard } from './hang-guard.ts';
import { outcomeOf, rethrow } from './helpers/module-scope-outcome.ts';

const scenario = `
import { spawnWithHangGuard } from ${JSON.stringify(new URL('./hang-guard.ts', import.meta.url).pathname)};
import { outcomeOf } from ${JSON.stringify(new URL('./helpers/module-scope-outcome.ts', import.meta.url).pathname)};

let grandchild;
const outcome = await outcomeOf(async () => {
  grandchild = spawnWithHangGuard(['sh', '-c', 'read line; exit 0'], {
    stdin: 'pipe',
    hangGuardMilliseconds: 3000,
  });
  setTimeout(() => {
    grandchild.stdin.write('release\\n');
    grandchild.stdin.end();
  }, 4000);
  console.log(JSON.stringify({ ready: [process.pid, grandchild.pid] }));
  await grandchild.exited;
}, 3000);
console.log(JSON.stringify({
  outcome: outcome instanceof Error ? outcome.message : null,
  exitCode: grandchild.exitCode,
  signalCode: grandchild.signalCode,
}));
`;

const survivesAFreeze = await outcomeOf(async () => {
  const child = spawnWithHangGuard([process.execPath, '--eval', scenario], { stdout: 'pipe' });
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let output = '';
  let frozen: number[] = [];
  try {
    while (!output.includes('"ready"')) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`scenario exited before it was ready: ${output}`);
      output += value;
    }
    frozen = (JSON.parse(output.trim().split('\n')[0]!) as { ready: number[] }).ready;
    for (const pid of frozen) process.kill(pid, 'SIGSTOP');
    await Bun.sleep(5_000);
    for (const pid of frozen.toReversed()) process.kill(pid, 'SIGCONT');
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      output += value;
    }
    expect(await child.exited).toBe(0);
    const report = JSON.parse(output.trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(report).toEqual({ outcome: null, exitCode: 0, signalCode: null });
  } finally {
    for (const pid of frozen) {
      try {
        process.kill(pid, 'SIGCONT');
      } catch {
        // Already gone.
      }
    }
    child.kill();
  }
});

it('a scenario frozen past its guard is neither reported hung nor has its child killed', () =>
  rethrow(survivesAFreeze));
