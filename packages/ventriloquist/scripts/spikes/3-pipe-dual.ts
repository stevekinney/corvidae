/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Spike 3: pipe mode with both stdout and stderr flooding, both pulled through gated read loops.
 * Shows (1) both channels stop in the kernel when neither is pulled, (2) each late-start read loop
 * (stdout taken immediately, stderr taken after the flood began) does not leave Bun buffering,
 * and (3) interleaved resume delivers each channel intact.
 */
import { pullReader } from './readers.ts';
import {
  cpuTimeOf,
  guard,
  killGroup,
  report,
  residentKilobytes,
  sleep,
  stateOf,
} from './spike-support.ts';

guard({ maximumRssMegabytes: 400, maximumSeconds: 60 });
const rss = (): number => Math.round((residentKilobytes(process.pid) ?? 0) / 1024);

const lateStderr = process.argv[2] === 'late';
// Two producers in one group: `yes` on stdout and `yes err` on stderr.
const child = Bun.spawn(['/bin/sh', '-c', 'yes out & yes err >&2 & wait'], {
  stdout: 'pipe',
  stderr: 'pipe',
  stdin: 'ignore',
  detached: true,
});
const counts = { out: 0, err: 0 };
let sawBad = false;
const check = (channel: 'out' | 'err') => (chunk: Uint8Array) => {
  counts[channel] += chunk.length;
  const first = chunk[0];
  if (
    first !== (channel === 'out' ? 111 : 101) &&
    first !== 10 &&
    first !== 117 &&
    first !== 116 &&
    first !== 114
  )
    sawBad = true;
};
const stdout = pullReader('out', child.stdout as ReadableStream<Uint8Array>, check('out'));
// With `late`, stderr is only handed to a reader after a delay, to see whether Bun buffers it meanwhile.
let stderr: ReturnType<typeof pullReader> | undefined;
const rssAtStart = rss();
if (lateStderr) await sleep(1500);
const rssAfterDelay = rss();
stderr = pullReader('err', child.stderr as ReadableStream<Uint8Array>, check('err'));
// Hold both paused for 3 seconds.
await sleep(3000);
const heldRss = rss();
const heldCounts = { ...counts };
const states = [stateOf(child.pid)];
stdout.resume();
stderr.resume();
await sleep(1000);
const flowed = { ...counts };
stdout.pause();
stderr.pause();
await sleep(500);
const afterPause = { ...counts };
await sleep(1000);
const flat = counts.out === afterPause.out && counts.err === afterPause.err;
report(`pipe-dual${lateStderr ? '-late' : ''}`, {
  ok:
    heldCounts.out === 0 &&
    heldCounts.err === 0 &&
    flowed.out > 0 &&
    flowed.err > 0 &&
    flat &&
    !sawBad &&
    heldRss - rssAtStart < 10,
  rssAtStartMb: rssAtStart,
  rssAfterDelayMb: rssAfterDelay,
  rssHeldMb: heldRss,
  pausedBytes: heldCounts,
  flowedMb: { out: Math.round(flowed.out / 1048576), err: Math.round(flowed.err / 1048576) },
  flatAfterRepause: flat,
  content: sawBad ? 'BAD' : 'ok',
  states,
  cpu: cpuTimeOf(child.pid),
});
killGroup(child.pid);
await Promise.race([child.exited, sleep(3000)]);
process.exit(0);
