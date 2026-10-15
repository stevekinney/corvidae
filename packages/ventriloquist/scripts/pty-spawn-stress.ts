/**
 * Hammers the PTY spawn path with a child that prints and exits at once, the shape that hangs
 * `Bun.spawn({ terminal })` on Bun 1.4.2 / macOS when the child finishes before the call returns
 * (https://github.com/oven-sh/bun/issues/45300). The helper's start gate must keep it from hanging.
 * Run several copies at once for pressure:
 *
 *   bun scripts/pty-spawn-stress.ts [count]
 *
 * It prints the iteration number to standard error and exits 0 after `count` spawns, so a hang is
 * a process that stops printing; wrap it in a watchdog. It is a manual tool, not a test, because
 * the failure it probes for is a host-load race with no deterministic assertion.
 */
import { createPtyProcess } from '../src/bun/pty-process.ts';

const count = Number(process.argv[2] ?? 2000);

for (let iteration = 1; iteration <= count; iteration += 1) {
  const hosted = createPtyProcess({
    profile: {
      executable: 'sh',
      argumentList: ['-c', 'printf tty'],
      workingDirectory: '/',
      environment: { PATH: '/usr/bin:/bin' },
    },
    dimensions: { columns: 80, rows: 24 },
  });
  await hosted.backend.start();
  await hosted.reportExitTo({
    start: async () => {},
    reportProcessExit: () => true,
  });
  const outcome = await hosted.backend.cleanup();
  if (outcome !== 'complete') throw new Error(`iteration ${iteration}: cleanup was ${outcome}`);
  if (iteration % 100 === 0) console.error(`iteration ${iteration}`);
}
console.error(`done ${count}`);
