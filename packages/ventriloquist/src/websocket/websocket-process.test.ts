import { expect } from 'bun:test';

import {
  isAlive,
  scenarioTest,
  settleScenarios,
  waitUntilGone,
} from '../bun/bun-process.test-support.ts';
import { createBunProcessFactory } from './bun-process-factory.ts';
import type { LaunchSnapshot } from './websocket-types.ts';
import { connect, startHarness } from './websocket.test-support.ts';

/**
 * The server over a real PTY. These bodies start real processes, so they run at module scope
 * through `scenarioTest`, off Bun's per-test clock, and each test only rethrows what it recorded.
 */
const launch = (script: string): LaunchSnapshot => ({
  mode: 'pty',
  profile: {
    executable: '/bin/sh',
    argumentList: ['-c', script],
    workingDirectory: '/',
    environment: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
  },
  dimensions: { columns: 80, rows: 24 },
});

function harnessFor(snapshot: LaunchSnapshot) {
  return startHarness({
    authorization: { allowed: true, grant: 'interactive', launch: snapshot },
    createProcess: createBunProcessFactory({ terminationGraceMilliseconds: 100 }),
  });
}

scenarioTest('a real shell echoes typed input back over the socket', async () => {
  const harness = harnessFor(launch('exec cat'));
  try {
    const client = connect(harness);
    await client.handshake();
    client.sendResult(client.endpoint.input('hello\r'));
    await client.waitForOutput('hello');
    const received = client.endpoint.outputBytes.received;
    client.sendResult(client.endpoint.consumeOutput(received));
    client.sendResult(client.endpoint.terminate());
    const awaited56 = await client.waitForKind('cleanup-result');
    expect(awaited56.outcome).toBe('complete');
    const awaited57 = await client.closed;
    expect(awaited57.code).toBe(1000);
  } finally {
    await harness.stop();
  }
});

scenarioTest('dropping the socket ends the real process the connection owns', async () => {
  const harness = harnessFor(launch('echo $$; exec cat'));
  try {
    const client = connect(harness);
    await client.handshake();
    const text = await client.waitForOutput(/\d+\r?\n/);
    const pid = Number(/(\d+)\r?\n/.exec(text)?.[1]);
    expect(isAlive(pid)).toBe(true);
    client.socket.close(1000);
    const summary = await harness.session().closed;
    expect(summary.cause).toBe('disconnect');
    expect(summary.cleanup).toBe('complete');
    await waitUntilGone(pid);
    expect(isAlive(pid)).toBe(false);
  } finally {
    await harness.stop();
  }
});

scenarioTest(
  'a process that exits is reported after its output, then cleaned up, then closed',
  async () => {
    const harness = harnessFor(launch('printf done; exit 3'));
    try {
      const client = connect(harness);
      await client.handshake();
      await client.waitForOutput('done');
      // A natural close drains first: it waits for the client to say it parsed what it was sent.
      client.sendResult(client.endpoint.consumeOutput(client.endpoint.outputBytes.received));
      expect(await client.waitForKind('process-exit')).toMatchObject({ exitCode: 3, signal: null });
      const awaited58 = await client.waitForKind('cleanup-result');
      expect(awaited58.outcome).toBe('complete');
      const awaited59 = await client.closed;
      expect(awaited59.code).toBe(1000);
      expect(client.kinds().indexOf('output')).toBeLessThan(client.kinds().indexOf('process-exit'));
    } finally {
      await harness.stop();
    }
  },
);

scenarioTest('an executable that does not exist is a spawn failure, never an exit', async () => {
  const harness = harnessFor({
    ...launch('true'),
    profile: { ...launch('true').profile, executable: '/nonexistent/shell' },
  });
  try {
    const client = connect(harness);
    await client.handshake();
    const awaited60 = await client.waitForKind('attachment-error');
    expect(awaited60.code).toBe('spawn-failed');
    const awaited61 = await client.closed;
    expect(awaited61.code).toBe(1011);
    expect(client.kinds()).not.toContain('process-exit');
  } finally {
    await harness.stop();
  }
});

await settleScenarios();
