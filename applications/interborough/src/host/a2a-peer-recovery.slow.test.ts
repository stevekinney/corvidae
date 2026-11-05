import { createAgent, stopWhen } from '@lostgradient/operative';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import { writeProviderHome } from './stub-provider.ts';

const homes: string[] = [];
const hosts: Host[] = [];
const children: ReturnType<typeof spawnWithHangGuard>[] = [];
async function exists(path: string, text?: string): Promise<boolean> {
  try {
    const contents = await readFile(path, 'utf8');
    return text === undefined || contents.includes(text);
  } catch {
    return false;
  }
}
async function startCaller(
  home: string,
  env: Record<string, string>,
): Promise<ReturnType<typeof spawnWithHangGuard>> {
  const child = spawnWithHangGuard(
    [process.execPath, '--no-install', join(import.meta.dir, 'a2a-peer-recovery-caller.ts')],
    {
      cwd: join(import.meta.dir, '..', '..'),
      env: { ...process.env, INTERBOROUGH_HOME: home, ...env },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );
  children.push(child);
  await waitUntil(() => exists(env['READY_FILE'] ?? ''), { message: 'caller ready' });
  return child;
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const recovery = await (async () => {
  const peerHome = await mkdtemp(join(tmpdir(), 'interborough-peer-recovery-'));
  homes.push(peerHome);
  const state = { sends: 0, active: false, release: () => {} };
  const peer = await startHost({
    environment: { INTERBOROUGH_HOME: peerHome },
    port: 0,
    a2aAgents: ['peer'],
    extraAgents: {
      agents: {
        peer: createAgent({
          name: 'peer',
          description: 'Peer',
          generate: async ({ signal }) => {
            state.sends += 1;
            state.active = true;
            await new Promise<void>((resolve, reject) => {
              const abort = () => reject(new Error('aborted'));
              signal?.addEventListener('abort', abort, { once: true });
              state.release = () => {
                signal?.removeEventListener('abort', abort);
                resolve();
              };
            });
            return { content: 'peer result', toolCalls: [] };
          },
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    },
  });
  hosts.push(peer);
  const callerHome = await mkdtemp(join(tmpdir(), 'interborough-caller-recovery-'));
  homes.push(callerHome);
  await writeProviderHome(callerHome);
  await mkdir(join(callerHome, 'agents'), { recursive: true });
  await writeFile(
    join(callerHome, 'agents', 'caller.md'),
    '---\nname: Caller\nmodel: anthropic/sonnet\ntools: [a2a-peer:peer]\n---\nDelegate.\n',
  );
  const configurationPath = join(callerHome, 'configuration.json');
  const configuration = JSON.parse(await readFile(configurationPath, 'utf8')) as Record<
    string,
    unknown
  >;
  configuration['a2aPeers'] = [
    { id: 'peer', description: 'Peer', url: new URL('/bureau/a2a/peer', peer.url).href },
  ];
  await writeFile(configurationPath, JSON.stringify(configuration));
  const files = {
    READY_FILE: join(callerHome, 'ready_file'),
    RUN_FILE: join(callerHome, 'run_file'),
    JOURNAL_FILE: join(callerHome, 'journal_file'),
    APPROVE_FILE: join(callerHome, 'approve_file'),
    GO_FILE: join(callerHome, 'go_file'),
    KEY_FILE: join(callerHome, 'key_file'),
    REVIEW_FILE: join(callerHome, 'review_file'),
    RESULT_FILE: join(callerHome, 'result_file'),
    ERROR_FILE: join(callerHome, 'error_file'),
    URL_FILE: join(callerHome, 'caller-url-first'),
  };
  const env = { ...files, PEER_PORT: peer.url.port };
  const first = await startCaller(callerHome, env);
  expect(await exists(files.JOURNAL_FILE)).toBe(false);
  await waitUntil(() => exists(files.REVIEW_FILE), { message: 'caller approval' });
  await writeFile(files.APPROVE_FILE, 'approve');
  await waitUntil(() => state.active, { message: 'peer send' });
  await writeFile(files.GO_FILE, 'read journal');
  if (state.sends !== 1)
    throw new Error(`expected one peer send before restart, got ${state.sends}`);
  await waitUntil(() => exists(files.JOURNAL_FILE), { message: 'peer journal' });
  const journalMarker = JSON.parse(await readFile(files.JOURNAL_FILE, 'utf8')) as {
    entry?: { taskId?: string };
  };
  expect(journalMarker.entry?.taskId).toBeString();
  first.kill('SIGKILL');
  await first.exited;
  const second = await startCaller(callerHome, {
    ...env,
    RESTART: '1',
    READY_FILE: join(callerHome, 'ready-second'),
    URL_FILE: join(callerHome, 'caller-url-second'),
  });
  state.release();
  await waitUntil(() => exists(files.RESULT_FILE, 'completed'), { message: 'replayed result' });
  const resultObserved = await exists(files.RESULT_FILE, 'completed');
  if (!resultObserved) throw new Error('replayed result was not observed');
  second.kill('SIGKILL');
  await second.exited;
  return { sends: state.sends, resultObserved };
})();

test('replays a recorded peer task after the caller process is lost', () => {
  expect(recovery.sends).toBe(1);
  expect(recovery.resultObserved).toBe(true);
});
