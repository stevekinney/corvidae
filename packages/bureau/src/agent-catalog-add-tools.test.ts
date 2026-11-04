/**
 * COR-2009 — a tool source the host connects is available at once, with no restart:
 * `agents.addTools` puts its tools in the catalog as the host's, and an agent file that names one
 * of them is ready before the call resolves. A name Bureau or a plugin holds is refused.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { disposeServed, serve } from './http/management/agent-definitions-fixtures.test-support.ts';
import { agentFileDirectory } from './sources/agent-file-directory.ts';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support.ts';

const roots: string[] = [];

afterEach(async () => {
  await disposeServed();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const listIssues = createTool({
  name: 'list_issues',
  description: 'Lists issues in a GitHub repository.',
  input: z.object({ repository: z.string() }),
  metadata: { readOnly: true, title: 'List issues' },
  execute: async () => [],
});

async function served() {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-add-tools-'));
  roots.push(directory);
  return serve({ directory, overrides: { agentSource: agentFileDirectory(directory, {}) } });
}

describe('agents.addTools', () => {
  it('adds the tools as the host’s, and an agent file that names one is ready without a restart', async () => {
    const harness = await served();
    await harness.put(
      'triager.md',
      agentFileText({ name: 'Triager', model: KNOWN_MODEL, tools: '[github__list_issues]' }),
    );
    await harness.bureau.agents.refresh();
    const before = harness.bureau.agents.list().find(({ id }) => id === 'triager');
    expect(before?.state).toBe('invalid');
    expect(before?.problem?.code).toBe('unknown-tool');

    await harness.bureau.agents.addTools({ github__list_issues: listIssues });

    expect(harness.bureau.agents.list().find(({ id }) => id === 'triager')?.state).toBe('ready');
    expect(
      harness.bureau.agents.tools().find(({ name }) => name === 'github__list_issues'),
    ).toMatchObject({
      title: 'List issues',
      tier: 'read-only',
      source: 'host',
      users: ['triager'],
    });
  });

  it('refuses a name Bureau holds, and adds nothing', async () => {
    const harness = await served();

    const refused = await rejectionOf(
      harness.bureau.agents.addTools({
        github__list_issues: listIssues,
        'settings-get': listIssues,
      }),
    );

    expect(refused).toMatchObject({ code: 'CONFLICT' });
    expect(harness.bureau.agents.tools().some(({ name }) => name === 'github__list_issues')).toBe(
      false,
    );
  });
});
