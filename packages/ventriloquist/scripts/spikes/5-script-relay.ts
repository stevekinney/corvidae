/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Spike 5: `script(1)` as a relay process that owns the PTY and writes its output to a pipe the
 * host pulls. Checks pause (producer blocks), the session/process-group identity of the real
 * command relative to the relay, and what happens to the command when the relay's group is killed.
 */
import { spawnSync } from 'node:child_process';
import { pullReader } from './readers.ts';
import {
  cpuTimeOf,
  guard,
  kill,
  killGroup,
  report,
  residentKilobytes,
  sleep,
  stateOf,
} from './spike-support.ts';

guard({ maximumRssMegabytes: 400, maximumSeconds: 60 });
const rss = (): number => Math.round((residentKilobytes(process.pid) ?? 0) / 1024);
const relay =
  process.platform === 'darwin'
    ? ['script', '-q', '/dev/null', 'yes']
    : ['script', '-qefc', 'yes', '/dev/null'];
const available = Bun.which('script');
if (available === null) {
  report('script-relay', { available: false });
  process.exit(0);
}
const child = Bun.spawn(relay, { stdout: 'pipe', stderr: 'ignore', stdin: 'pipe', detached: true });
let received = 0;
const reader = pullReader(
  'script',
  child.stdout as ReadableStream<Uint8Array>,
  (c) => (received += c.length),
);
reader.resume();
while (received < 2 * 1048576) await sleep(5);
reader.pause();
await sleep(500);
const before = received;
const rssBefore = rss();
await sleep(3000);
const rssAfter = rss();
// Find the real `yes` and compare its identity with script's.
const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,command='], {
  encoding: 'utf8',
}).stdout.split('\n');
const mine = table.filter((l) => /\byes\b|\bscript\b/.test(l) && !/spike|grep/.test(l));
const relayPid = child.pid;
const yesLine = table.find((l) => l.trim().split(/\s+/)[1] === String(relayPid) && /yes/.test(l));
const yesPid = yesLine === undefined ? undefined : Number(yesLine.trim().split(/\s+/)[0]);
const states = {
  relay: stateOf(relayPid),
  yes: yesPid === undefined ? 'not found' : stateOf(yesPid),
};
const paused = received === before;
// Kill only the relay's process group, as host cleanup of the spawned pid would.
killGroup(relayPid);
await Promise.race([child.exited, sleep(3000)]);
await sleep(700);
const yesSurvived = yesPid !== undefined && stateOf(yesPid) !== 'gone';
if (yesSurvived && yesPid !== undefined) kill(yesPid);
report('script-relay', {
  available: true,
  relay,
  flatWhilePaused: paused,
  hostRssBeforeMb: rssBefore,
  hostRssAfterMb: rssAfter,
  states,
  relayCpu: cpuTimeOf(relayPid),
  processRows: mine.map((l) => l.trim().slice(0, 80)),
  commandSurvivedRelayGroupKill: yesSurvived,
});
process.exit(0);
