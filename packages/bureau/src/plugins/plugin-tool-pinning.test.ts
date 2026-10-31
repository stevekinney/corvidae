/**
 * COR-1879 — a plugin's unversioned tool takes its plugin's version, so a durable record of a call
 * to it pins `plugin:name@version`: a restart at the same version resumes the call, and a restart at
 * another reports `version-mismatch` and never runs it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePlugin } from '@lostgradient/interborough-plugin';
import type { Storage } from '@lostgradient/storage';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { PinnedToolUnavailableError } from '../index';
import { agentFileDirectory } from '../sources/agent-file-directory';
import { waitForCondition } from '../test';
import { createSqliteStorageFixture } from '../test/storage-fixtures';
import { agentFileText, KNOWN_MODEL } from '../testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from '../testing/agent-file-bureau.test-support';
import type { BureauDiagnostic } from '../types';

const SECRET = 'plugin-tool-secret';
const executed: string[] = [];
const roots: string[] = [];
const harnesses: FileBureauHarness[] = [];
const fixtures: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  executed.length = 0;
});

/** Plugin `p` at `version`, contributing the unversioned, mutating tool `t`. */
function pluginAt(version: string) {
  return definePlugin({
    name: 'p',
    version,
    description: 'Contributes t.',
    setup: () => ({
      tools: [
        createTool({
          name: 't',
          description: 'Changes something',
          input: z.object({ item: z.string() }),
          metadata: { mutates: true },
          execute: async ({ item }) => {
            executed.push(`${version}:${item}`);
            return { changed: item };
          },
        }),
      ],
    }),
  });
}

async function start(
  directory: string,
  version: string,
  storage: Storage,
  diagnostics: BureauDiagnostic[] = [],
) {
  let asked = false;
  const harness = await startFileBureau({
    directory,
    scripts: {
      [KNOWN_MODEL.split('/')[1] as string]: () => {
        if (asked) return 'Done.';
        asked = true;
        // A provider calls the tool `p__t`, the name Armorer exports a namespaced tool under.
        return { content: '', toolCalls: [{ name: 'p__t', arguments: { item: 'x' } }] };
      },
    },
    overrides: {
      agentApprovalSecret: SECRET,
      agentSource: agentFileDirectory(directory),
      plugins: [{ descriptor: pluginAt(version), source: 'package', location: '@example/p' }],
      storage,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  });
  harnesses.push(harness);
  return harness;
}

describe('a plugin tool’s version on a durable record', () => {
  it('registers p:t@2.0.0, resumes at 2.0.0 after a restart, and reports version-mismatch and pinned-version-unavailable at 3.0.0', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bureau-plugin-tool-'));
    roots.push(directory);
    const database = createSqliteStorageFixture();
    fixtures.push(database);

    const first = await start(directory, '2.0.0', database.storage);
    const [firstListing] = await first.bureau.plugins.list();
    expect(firstListing?.contributions).toEqual([
      { kind: 'tool', id: 'p:t@2.0.0', references: { agents: 0, schedules: 0, waitingRuns: 0 } },
    ]);
    await first.put('helper.md', agentFileText({ model: KNOWN_MODEL, tools: '[p:t]' }));
    await first.bureau.agents.refresh();
    const task = await first.bureau.tasks.start('helper', 'Go.');
    await task.result();
    const [pending] = first.bureau.reviews.list();
    expect(pending?.kind).toBe('tool-approval');
    await first.dispose();
    harnesses.splice(harnesses.indexOf(first), 1);

    // The same version: the call is restored and runs once approved.
    const resumed = await start(directory, '2.0.0', await database.reopen());
    await waitForCondition(
      () => resumed.bureau.reviews.list().length === 1,
      'the pending approval was not restored at the same plugin version',
    );
    await resumed.bureau.reviews.resolve({
      id: resumed.bureau.reviews.list()[0]!.id,
      decision: 'approve',
      principal: 'api-key:approver',
    });
    expect(executed).toEqual(['2.0.0:x']);
    await resumed.dispose();
    harnesses.splice(harnesses.indexOf(resumed), 1);

    // A second pending call, then a restart at 3.0.0.
    const again = await start(directory, '2.0.0', await database.reopen());
    const second = await again.bureau.tasks.start('helper', 'Again.');
    await second.result();
    expect(again.bureau.reviews.list()).toHaveLength(1);
    await again.dispose();
    harnesses.splice(harnesses.indexOf(again), 1);

    const diagnostics: BureauDiagnostic[] = [];
    const upgraded = await start(directory, '3.0.0', await database.reopen(), diagnostics);
    const recovery = diagnostics.find((diagnostic) => diagnostic.scope === 'approval-recovery');
    expect(recovery?.cause).toBeInstanceOf(PinnedToolUnavailableError);
    // The record names `p:t@2.0.0` and only `p:t@3.0.0` is loaded.
    const cause = recovery?.cause as PinnedToolUnavailableError;
    expect(cause.reason).toBe('version-mismatch');
    expect(cause.toolId).toBe('p:t@2.0.0');
    expect(cause.candidates).toEqual(['p:t@3.0.0']);
    expect(upgraded.bureau.reviews.list()).toEqual([]);
    expect(executed).toEqual(['2.0.0:x']);
    // The plugin reports the run that waited on the version it no longer loads.
    const [upgradedListing] = await upgraded.bureau.plugins.list();
    expect(upgradedListing?.problems).toEqual([
      { code: 'pinned-version-unavailable', id: 'p:t', version: '2.0.0', waitingRuns: 1 },
    ]);
  });
});
