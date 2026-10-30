/**
 * COR-1810 — a seeded agent's reply details are populated. The seeded agents name their own model
 * and seal no context epochs, so the details read `pinned` and a context record with no epoch.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const QUESTION = 'PRIVATE-QUESTION-7c1e';
const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('the reply details of a seeded agent', () => {
  for (const agentName of ['assistant', 'echo']) {
    test(`${agentName} returns a plan reason and an effective context`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'interborough-reply-details-'));
      directories.push(home);
      const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
      hosts.push(host);

      const task = await host.bureau.tasks.start(agentName, QUESTION);
      await task.result();
      const inspection = await host.bureau.tasks.inspect(task.id, { step: 0 });

      const [step] = inspection?.steps ?? [];
      expect(step?.planReason?.code).toBe('pinned');
      expect(step?.hasEffectiveContext).toBe(true);
      expect(step?.effectiveContext?.messages.map((message) => message.role)).toContain('user');
      expect(step?.effectiveContext?.epochId).toBeUndefined();
      expect(JSON.stringify(step?.effectiveContext)).not.toContain(QUESTION);
    });
  }
});
