/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Spike 4: does `Bun.file(masterFd).stream()` stop reading a PTY master when it is not pulled?
 * Reads two chunks, then never calls read() again, and samples host RSS and the producer's CPU
 * time once a second.
 */
import { spawnOnPty } from './own-pty.ts';
import {
  cpuTimeOf,
  guard,
  killGroup,
  report,
  residentKilobytes,
  sleep,
  stateOf,
} from './spike-support.ts';

guard({ maximumRssMegabytes: 500, maximumSeconds: 40 });
const seconds = Number(process.argv[2] ?? 10);
const { child, pair } = spawnOnPty(['yes'], { nonBlocking: true });
const reader = Bun.file(pair.masterFd).stream().getReader();
let read = 0;
for (let i = 0; i < 2; i += 1) read += (await reader.read()).value?.length ?? 0;
const samples: { t: number; rssMb: number; cpu: string; state: string }[] = [];
for (let t = 1; t <= seconds; t += 1) {
  await sleep(1000);
  samples.push({
    t,
    rssMb: Math.round((residentKilobytes(process.pid) ?? 0) / 1024),
    cpu: cpuTimeOf(child.pid),
    state: stateOf(child.pid),
  });
}
report('bunfile-idle', { readBytes: read, samples });
killGroup(child.pid);
process.exit(0);
