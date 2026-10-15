/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Spike 9: lifecycle of the owned PTY with the worker reader.
 *  - abandon: closing the gate without a byte ends the shell without running the command
 *  - escaped: a setsid'd descendant keeps the slave open after the group is killed; stopping the
 *    reader must still end the worker thread promptly
 *  - natural exit: the host process must exit by itself afterwards (no leaked thread or handle)
 *  - cost: descriptors and RSS per idle session, and descriptors after cleanup
 */
import { readdirSync } from 'node:fs';
import { closeMaster, spawnOnPty } from './own-pty.ts';
import { workerReader } from './readers.ts';
import { guard, killGroup, report, residentKilobytes, sleep, stateOf } from './spike-support.ts';

guard({ maximumRssMegabytes: 600, maximumSeconds: 60 });
const fds = (): number =>
  readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length;
const rssMb = (): number => Math.round((residentKilobytes(process.pid) ?? 0) / 1024);
const out: Record<string, unknown> = {};

// abandon
{
  const { child, pair } = spawnOnPty(['sh', '-c', 'echo SHOULD-NOT-RUN'], { abandon: true });
  const chunks: number[] = [];
  const reader = workerReader(pair.masterFd, (c) => chunks.push(...c));
  reader.resume();
  const exit = await Promise.race([child.exited, sleep(3000).then(() => 'TIMEOUT')]);
  const ended = await Promise.race([
    reader.done,
    sleep(3000).then(() => ({ ok: false, error: 'TIMEOUT' })),
  ]);
  out['abandon'] = {
    exit,
    ran: Buffer.from(chunks).toString().includes('SHOULD-NOT-RUN'),
    readerEnded: ended,
  };
  closeMaster(pair);
}

// escaped descendant keeps the slave open
{
  const { child, pair } = spawnOnPty(
    ['sh', '-c', `perl -MPOSIX -e 'setsid(); sleep 30' & echo started; sleep 30`],
    {},
  );
  let seen = '';
  const reader = workerReader(pair.masterFd, (c) => (seen += Buffer.from(c).toString()));
  reader.resume();
  for (let i = 0; i < 100 && !seen.includes('started'); i += 1) await sleep(20);
  killGroup(child.pid);
  const exit = await Promise.race([child.exited, sleep(3000).then(() => 'TIMEOUT')]);
  const eofSoon = await Promise.race([reader.done.then(() => true), sleep(700).then(() => false)]);
  const stopAt = performance.now();
  reader.close();
  const ended = await Promise.race([
    reader.done,
    sleep(3000).then(() => ({ ok: false, error: 'TIMEOUT' })),
  ]);
  out['escaped'] = {
    exit,
    readerSawEofWhileDescendantHoldsSlave: eofSoon,
    stopToEndMs: Math.round(performance.now() - stopAt),
    readerEnded: ended,
    descendantStillRunning: stateOf(child.pid),
  };
  closeMaster(pair);
  // The perl descendant is ours (it was started by this run); find and end it by its parent chain.
}

// cost per idle session
{
  const before = { fds: fds(), rss: rssMb() };
  const sessions = [];
  for (let i = 0; i < 20; i += 1) {
    const s = spawnOnPty(['sleep', '30'], {});
    const reader = workerReader(s.pair.masterFd, () => undefined);
    reader.resume();
    sessions.push({ ...s, reader });
  }
  await sleep(1000);
  const during = { fds: fds(), rss: rssMb() };
  for (const s of sessions) killGroup(s.child.pid);
  await Promise.all(sessions.map((s) => s.child.exited));
  for (const s of sessions) {
    s.reader.close();
    await Promise.race([s.reader.done, sleep(2000)]);
    closeMaster(s.pair);
  }
  await sleep(500);
  const after = { fds: fds(), rss: rssMb() };
  out['cost20Sessions'] = {
    before,
    during,
    after,
    fdsPerSession: (during.fds - before.fds) / 20,
    rssPerSessionMb: Math.round(((during.rss - before.rss) / 20) * 10) / 10,
  };
}
report('lifecycle', out);
// No process.exit(): the run is only valid if the host ends by itself.
setTimeout(() => {
  console.log('HOST-DID-NOT-EXIT-NATURALLY');
  process.exit(3);
}, 5000).unref();
