/**
 * The host's workflow directory (COR-1527): JSON files in Bungalow's `workflows/` directory are
 * workflows of the Bureau. Their agent steps run the host's agents, here the seeded `assistant`,
 * whose reply is scripted; no model is called.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import { scriptedAssistantAgents } from './scripted-assistant.test-support.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const DIGEST = JSON.stringify({
  name: 'digest',
  agent: 'assistant',
  trigger: { kind: 'schedule', spec: '1h' },
  steps: [{ kind: 'activity', handler: 'agent', input: { agent: 'assistant', message: 'Hello' } }],
});

async function startAt(files: Readonly<Record<string, string>> = {}): Promise<{
  readonly host: Host;
  readonly home: string;
}> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-workflows-'));
  directories.push(home);
  if (Object.keys(files).length > 0) {
    await mkdir(join(home, 'workflows'), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(home, 'workflows', name), text);
    }
  }
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    extraAgents: scriptedAssistantAgents(),
  });
  hosts.push(host);
  return { host, home };
}

describe('the host’s workflow directory', () => {
  test('is the workflows directory under the Interborough home, created on start', async () => {
    const { host, home } = await startAt();
    expect(host.bureau.workflows?.list()).toEqual([]);
    const created = await host.bureau.workflows?.create('digest', {
      agent: 'assistant',
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [
        { kind: 'activity', handler: 'agent', input: { agent: 'assistant', message: 'Hello' } },
      ],
    });
    expect(created?.id).toBe('digest');
    expect(JSON.parse(await readFile(join(home, 'workflows', 'digest.json'), 'utf8')).name).toBe(
      'digest',
    );
  });

  test('is where /host/paths says a file is written, so the page can show its path', async () => {
    const { host, home } = await startAt();
    const response = await fetch(new URL('/host/paths', host.url));
    expect(response.status).toBe(200);
    const paths = (await response.json()) as { workflowDirectory: string };
    expect(paths.workflowDirectory).toBe(join(home, 'workflows'));
    await host.bureau.workflows?.create('digest', {
      agent: 'assistant',
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [
        { kind: 'activity', handler: 'agent', input: { agent: 'assistant', message: 'Hello' } },
      ],
    });
    // The path the page shows is a file that exists.
    expect(
      JSON.parse(await readFile(join(paths.workflowDirectory, 'digest.json'), 'utf8')).name,
    ).toBe('digest');
  });

  test('loads a file at start, owns it as the deployment’s owner, and runs its agent step', async () => {
    const { host } = await startAt({ 'digest.json': DIGEST });
    expect(host.bureau.workflows?.list()).toMatchObject([
      { id: 'digest', state: 'ready', owner: 'anonymous:local', agent: 'assistant' },
    ]);

    const run = await host.engine.start(
      'digest',
      { kind: 'schedule', scheduleId: 'manual' },
      { id: 'digest-run' },
    );
    const result = (await run.result()) as { content: string };
    expect(result.content).toContain('Hello from the assistant');
    expect(await host.bureau.ownerOf({ kind: 'run', id: 'digest-run' })).toBe('anonymous:local');
    // The workflow has its one native schedule.
    const schedules = await host.bureau.schedules.list({ status: ['active'] });
    expect(schedules?.items.map((schedule) => schedule.id)).toEqual([
      'bureau-workflow-schedule:digest:1',
    ]);
  });

  test('lists a file that cannot be used as invalid and keeps the others', async () => {
    const { host } = await startAt({ 'digest.json': DIGEST, 'broken.json': '{' });
    const byId = Object.fromEntries(
      (host.bureau.workflows?.list() ?? []).map((listing) => [listing.id, listing]),
    );
    expect(byId['digest']?.state).toBe('ready');
    expect(byId['broken']).toMatchObject({ state: 'invalid', problem: { code: 'invalid-json' } });
  });
});
