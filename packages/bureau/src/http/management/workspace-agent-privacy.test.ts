import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'bun:test';
import { DEFINITION, disposeServed, serve } from './agent-definitions-fixtures.test-support.ts';
import { createBureauHandler } from '../create-bureau-handler.ts';
import { agentFileDirectory } from '../../sources/agent-file-directory.ts';
import { agentFileText, KNOWN_MODEL } from '../../testing/agent-file-fixtures.test-support.ts';
import { waitForCondition } from '../../test';
import {
  WORKSPACE_PRIVACY_ACTORS,
  workspacePrivacyAuthentication,
  workspacePrivacyCall,
  workspacePrivacyDirectory,
  type WorkspacePrivacyActor,
} from '../workspace-privacy-fixtures.test-support.ts';

afterEach(disposeServed);
const actors = Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[];
const cases = [
  ['bureau.agents.list', false],
  ['bureau.agents.models', false],
  ['bureau.agents.references', true],
  ['bureau.agents.try', true],
  ['bureau.agents.definitions.create', true],
  ['bureau.agents.definitions.update', true],
  ['bureau.agents.definitions.delete', true],
  ['bureau.agents.definitions.get', false],
  ['bureau.agents.definitions.list', false],
  ['bureau.agents.definitions.revisions', false],
  ['bureau.agents.catalog', false],
  ['bureau.agents.versions.list', false],
  ['bureau.agents.versions.restore', true],
  ['bureau.agents.overrides.get', false],
  ['bureau.agents.overrides.update', true],
] as const;

for (const [operation, administrative] of cases) {
  test(`${operation} executes all six actor cases on real shared agent files`, async () => {
    const workspace = workspacePrivacyDirectory();
    const served = await serve({ overrides: { workspace } });
    const fixture = {
      handler: createBureauHandler(served.bureau, {
        workspace,
        authentication: workspacePrivacyAuthentication,
      }),
    };
    const created = await workspacePrivacyCall(
      fixture,
      'administrator',
      'bureau.agents.definitions.create',
      { id: 'workspace-agent', definition: DEFINITION },
    );
    expect(created.body?.error).toBeUndefined();
    let hash = created.body?.result?.['hash'];
    if (operation === 'bureau.agents.versions.restore') {
      const updated = await workspacePrivacyCall(
        fixture,
        'administrator',
        'bureau.agents.definitions.update',
        {
          id: 'workspace-agent',
          expectedHash: hash,
          definition: { ...DEFINITION, description: 'second shared revision' },
        },
      );
      expect(updated.body?.error).toBeUndefined();
      hash = updated.body?.result?.['hash'];
    }
    const override = await workspacePrivacyCall(fixture, 'owner', 'bureau.agents.overrides.get', {
      id: 'alpha',
    });
    expect(override.body?.error).toBeUndefined();
    const privateTask = await served.bureau.tasks.start(
      'workspace-agent',
      'PRIVATE-AGENT-RUN-837d',
      { principal: WORKSPACE_PRIVACY_ACTORS.owner.owner },
    );
    await waitForCondition(
      () => served.bureau.tasks.detail(privateTask.id)?.status === 'completed',
      'private file-agent run completes',
    );
    const input =
      operation === 'bureau.agents.list' ||
      operation === 'bureau.agents.catalog' ||
      operation === 'bureau.agents.definitions.list'
        ? {}
        : operation === 'bureau.agents.models' || operation === 'bureau.agents.references'
          ? { agentName: 'workspace-agent' }
          : operation === 'bureau.agents.try'
            ? { definition: DEFINITION, message: 'administrator test' }
            : operation === 'bureau.agents.definitions.create'
              ? { id: 'new-workspace-agent', definition: DEFINITION }
              : operation === 'bureau.agents.definitions.update'
                ? {
                    id: 'workspace-agent',
                    expectedHash: hash,
                    definition: { ...DEFINITION, description: 'updated shared definition' },
                  }
                : operation === 'bureau.agents.definitions.delete'
                  ? { id: 'workspace-agent', expectedHash: hash }
                  : operation === 'bureau.agents.versions.restore'
                    ? { id: 'workspace-agent', revision: 1, expectedHash: hash }
                    : operation === 'bureau.agents.overrides.get'
                      ? { id: 'alpha' }
                      : operation === 'bureau.agents.overrides.update'
                        ? {
                            id: 'alpha',
                            expectedHash: override.body?.result?.['hash'],
                            overrides: { stepLimit: 20 },
                          }
                        : { id: 'workspace-agent' };
    for (const actor of [
      ...actors.filter((value) => value !== 'administrator'),
      'administrator',
    ] as WorkspacePrivacyActor[]) {
      const result = await workspacePrivacyCall(fixture, actor, operation, input);
      if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
      else if (administrative && actor !== 'administrator')
        expect(result.body?.error?.data?.httpStatus).toBe(403);
      else {
        expect(result.body?.error).toBeUndefined();
        expect(result.text).not.toContain('PRIVATE-AGENT-RUN-837d');
        expect(result.text).not.toContain(privateTask.id);
        if (operation === 'bureau.agents.definitions.revisions') {
          if (actor === 'owner') expect(result.body?.result?.['revisions']).not.toEqual([]);
          else expect(result.body?.result?.['revisions']).toEqual([]);
        }
      }
    }
  });
}

test('bureau.agents.definitions.duplicate checks all six actors on a real plugin agent layer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-plugin-agent-'));
  const plugin = join(root, 'plugin');
  const owner = join(root, 'owner');
  await mkdir(plugin);
  await mkdir(owner);
  try {
    await writeFile(
      join(plugin, 'triager.md'),
      agentFileText({ name: 'Triager', model: KNOWN_MODEL }),
    );
    const workspace = workspacePrivacyDirectory();
    const served = await serve({
      directory: owner,
      overrides: {
        workspace,
        agentSource: [agentFileDirectory(owner), agentFileDirectory(plugin, { plugin: 'fixture' })],
      },
    });
    await served.bureau.agents.refresh();
    const fixture = {
      handler: createBureauHandler(served.bureau, {
        workspace,
        authentication: workspacePrivacyAuthentication,
      }),
    };
    for (const actor of [
      ...actors.filter((value) => value !== 'administrator'),
      'administrator',
    ] as WorkspacePrivacyActor[]) {
      const result = await workspacePrivacyCall(
        fixture,
        actor,
        'bureau.agents.definitions.duplicate',
        { id: 'fixture:triager' },
      );
      if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
      else if (actor === 'administrator') {
        expect(result.body?.error).toBeUndefined();
        expect(result.body?.result?.['id']).toBe('triager');
      } else expect(result.body?.error?.data?.httpStatus).toBe(403);
    }
  } finally {
    await disposeServed();
    await rm(root, { recursive: true, force: true });
  }
});
