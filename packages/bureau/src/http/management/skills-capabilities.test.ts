/**
 * COR-1818 — the capabilities a host shows beside the agents: `bureau.skills.list` (the executable
 * skills a host discovered, each with its source and trust), `bureau.agents.catalog` (each tool
 * with its schema, tier, default approval, source, and users), and the definition a code-defined
 * agent states about itself in `bureau.agents.definitions.get`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgent, createModelCatalog, withBackendDescriptors } from '@lostgradient/operative';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createAgentSkills } from '../../agent-skills.ts';
import {
  AUDIT_SYNTHETIC_OWNER_PREFIXES,
  auditTrailSkillSourceOwnerId,
  auditTrailToolSourceOwnerId,
} from '../../audit-trail.ts';
import { ANONYMOUS_LOCAL_OWNER } from '../../owner-of-record.ts';
import { agentFileDirectory } from '../../sources/agent-file-directory.ts';
import { createSkillClient } from '../../skills/client/skill-client.ts';
import { createFilesystemArtifactLoader } from '../../skills/client/artifact-loader.ts';
import { discoverSkills } from '../../skills/discovery/discover.ts';
import { admitSources, type SkillSource } from '../../skills/discovery/source.ts';
import { agentFileText, KNOWN_MODEL } from '../../testing/agent-file-fixtures.test-support.ts';
import { createBureauHandler } from '../create-bureau-handler.ts';
import { callAs, disposeServed, listOf, serve } from './agent-definitions-fixtures.test-support.ts';
import { authentication, rpc } from './management-fixtures.test-support.ts';
import type { SkillsStanding } from './skills-operations.ts';

const roots: string[] = [];

afterEach(async () => {
  await disposeServed();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const now = (): string => '2026-10-30T00:00:00.000Z';

/** The agent `serve` allowlists for A2A, which every Bureau it serves must hold. */
const alpha = () =>
  createAgent({ name: 'alpha', generate: async () => ({ content: 'alpha', toolCalls: [] }) });

async function skillsDirectory(
  skills: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bureau-skills-capabilities-'));
  roots.push(root);
  for (const [name, allowedTools] of Object.entries(skills)) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(
      join(root, name, 'SKILL.md'),
      [
        '---',
        `name: ${name}`,
        `description: Description for ${name}`,
        ...(allowedTools === undefined ? [] : [`allowed-tools: ${allowedTools}`]),
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
    );
  }
  return root;
}

/** A user source (trusted by default) and a project source (untrusted until admitted). */
async function twoSources(): Promise<readonly SkillSource[]> {
  const user = await skillsDirectory({ summarize: 'read_file grep', translate: undefined });
  const project = await skillsDirectory({ deploy: 'run_shell' });
  return [
    { id: 'home', kind: 'user', location: user, precedence: 20 },
    { id: 'workspace', kind: 'project', location: project, precedence: 10 },
  ];
}

describe('bureau.skills.list', () => {
  it('lists the configured skills with their source, trust, and allowed tools', async () => {
    const sources = await twoSources();
    const catalog = await discoverSkills({ sources, trustPolicy: admitSources([]), now });
    const standing: SkillsStanding = {
      catalog,
      sources: sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        location: source.location,
        trust: source.kind === 'project' ? 'untrusted' : 'trusted',
        trustReason: 'test',
      })),
      trustLocked: 'deployment',
    };
    const served = await serve();
    const handler = createBureauHandler(served.bureau, {
      unauthenticatedAccess: 'allow',
      skills: { standing: () => standing },
    });

    const response = await callAs(handler, 'bureau.skills.list', {});

    expect(response.error).toBeUndefined();
    expect(response.result?.['revision']).toBe(catalog.revision);
    expect(response.result?.['trustLocked']).toBe('deployment');
    expect(listOf(response, 'skills')).toEqual([
      {
        name: 'deploy',
        description: 'Description for deploy',
        source: { id: 'workspace', kind: 'project', location: sources[1]?.location, plugin: null },
        trust: 'untrusted',
        trustReason: expect.any(String),
        available: false,
        unavailableReason: 'source-untrusted',
        allowedTools: ['run_shell'],
      },
      expect.objectContaining({
        name: 'summarize',
        trust: 'trusted',
        available: true,
        unavailableReason: null,
        allowedTools: ['read_file', 'grep'],
      }),
      expect.objectContaining({ name: 'translate', allowedTools: [] }),
    ]);
    expect(
      listOf(response, 'sources').map((source) => [source['id'], source['skillCount']]),
    ).toEqual([
      ['home', 2],
      ['workspace', 1],
    ]);
  });

  it('lists a skill from a plugin source with kind plugin and its plugin name (COR-1873)', async () => {
    const owner = await skillsDirectory({ summarize: undefined });
    const shipped = await skillsDirectory({ triage: undefined });
    const sources: readonly SkillSource[] = [
      { id: 'home', kind: 'user', location: owner, precedence: 20 },
      { id: 'plugin-linear', kind: 'plugin', plugin: 'linear', location: shipped, precedence: 35 },
    ];
    const catalog = await discoverSkills({ sources, now });
    const standing: SkillsStanding = {
      catalog,
      sources: sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        location: source.location,
        ...(source.plugin === undefined ? {} : { plugin: source.plugin }),
        trust: 'trusted',
        trustReason: 'test',
      })),
    };
    const served = await serve();
    const handler = createBureauHandler(served.bureau, {
      unauthenticatedAccess: 'allow',
      skills: { standing: () => standing },
    });

    const response = await callAs(handler, 'bureau.skills.list', {});

    expect(response.error).toBeUndefined();
    expect(listOf(response, 'skills')).toEqual([
      expect.objectContaining({
        name: 'summarize',
        source: { id: 'home', kind: 'user', location: owner, plugin: null },
      }),
      expect.objectContaining({
        name: 'triage',
        source: { id: 'plugin-linear', kind: 'plugin', location: shipped, plugin: 'linear' },
        // Plugins are trusted code, so a skill one ships is available without admitting it.
        trust: 'trusted',
        available: true,
      }),
    ]);
    expect(
      listOf(response, 'sources').map((source) => [source['id'], source['kind'], source['plugin']]),
    ).toEqual([
      ['home', 'user', null],
      ['plugin-linear', 'plugin', 'linear'],
    ]);
  });

  it('refuses an activation of an untrusted skill with source-untrusted, and admits it once trusted', async () => {
    const sources = await twoSources();
    const untrusted = await discoverSkills({ sources, trustPolicy: admitSources([]), now });
    const client = createSkillClient({
      catalog: untrusted,
      loadArtifact: createFilesystemArtifactLoader(),
      now,
    });

    const refused = await client.activate('deploy');
    expect(refused).toMatchObject({ activated: false, refusal: 'source-untrusted' });
    // A skill a client was granted is no exception: the grant narrows what is available, and an
    // untrusted skill was never available to grant.
    const granted = client.attenuate({ skills: ['deploy', 'summarize'] });
    expect(granted.offered().map((entry) => entry.name)).toEqual(['summarize']);
    expect(await granted.activate('deploy')).toMatchObject({ activated: false });

    const admitted = await discoverSkills({
      sources,
      trustPolicy: admitSources(['workspace']),
      now,
    });
    const trustedClient = createSkillClient({
      catalog: admitted,
      loadArtifact: createFilesystemArtifactLoader(),
      now,
    });
    expect(await trustedClient.activate('deploy')).toMatchObject({ activated: true });
  });

  it('answers an empty list when the host discovers no skills', async () => {
    const served = await serve();

    const response = await callAs(served.local, 'bureau.skills.list', {});

    expect(response.result).toEqual({ revision: null, skills: [], sources: [], trustLocked: null });
  });

  it('needs bureau.agents:read unless the caller owns the deployment’s agents', async () => {
    const served = await serve();

    const unscoped = await rpc(served.keyed, 'bureau.skills.list', {}, 'alice-key');
    const reader = await rpc(served.keyed, 'bureau.skills.list', {}, 'agents-reader-key');

    expect(unscoped.error?.data?.httpStatus).toBe(403);
    expect(reader.error).toBeUndefined();
    const owner = await callAs(served.owner, 'bureau.skills.list', {});
    expect(owner.error).toBeUndefined();
  });

  it('reads the host’s standing on every request, so a trust change shows on the next call', async () => {
    const sources = await twoSources();
    let trusted: string[] = [];
    const served = await serve();
    const handler = createBureauHandler(served.bureau, {
      authentication,
      skills: {
        standing: async () => ({
          catalog: await discoverSkills({ sources, trustPolicy: admitSources(trusted), now }),
          sources: [],
        }),
      },
    });

    const before = await rpc(handler, 'bureau.skills.list', {}, 'agents-reader-key');
    trusted = ['workspace'];
    const after = await rpc(handler, 'bureau.skills.list', {}, 'agents-reader-key');

    const deploy = (body: typeof before) =>
      listOf(body, 'skills').find((skill) => skill['name'] === 'deploy');
    expect(deploy(before)).toMatchObject({ trust: 'untrusted', available: false });
    expect(deploy(after)).toMatchObject({ trust: 'trusted', available: true });
  });
});

describe('the audit record of a skill source’s trust change', () => {
  it('is filed under the source, names the decision, and belongs to the owner who made it', async () => {
    const served = await serve();
    const trail = served.bureau.internals.auditTrail;
    if (trail === undefined) throw new Error('The Bureau keeps no audit trail.');
    const resource = auditTrailSkillSourceOwnerId('workspace');
    await trail.record({
      runId: resource,
      type: 'skill.source.trusted',
      principal: ANONYMOUS_LOCAL_OWNER,
      detail: { sourceId: 'workspace', trusted: true, owner: ANONYMOUS_LOCAL_OWNER },
    });

    const asOperator = await rpc(
      served.keyed,
      'bureau.audit.query',
      { runId: resource },
      'operator-key',
    );
    const asStranger = await rpc(
      served.keyed,
      'bureau.audit.query',
      { runId: resource },
      'alice-key',
    );

    expect(listOf(asOperator as never, 'records')).toEqual([
      expect.objectContaining({
        type: 'skill.source.trusted',
        resource,
        principal: ANONYMOUS_LOCAL_OWNER,
        detail: { sourceId: 'workspace', trusted: true },
      }),
    ]);
    // The owner string is the deployment's, so a caller who is not that owner reads nothing.
    expect(listOf(asStranger as never, 'records')).toEqual([]);
    expect(AUDIT_SYNTHETIC_OWNER_PREFIXES).toContain('skill-source:');
  });
});

describe('the audit record of a saved tool source’s change', () => {
  it('is filed under the source, shows the command line, and belongs to the owner who made it', async () => {
    const served = await serve();
    const trail = served.bureau.internals.auditTrail;
    if (trail === undefined) throw new Error('The Bureau keeps no audit trail.');
    const resource = auditTrailToolSourceOwnerId('files');
    await trail.record({
      runId: resource,
      type: 'tool.source.connected',
      principal: ANONYMOUS_LOCAL_OWNER,
      detail: {
        sourceId: 'files',
        owner: ANONYMOUS_LOCAL_OWNER,
        commandLine: 'npx -y @example/files-server',
        env: { TOKEN: 'never-shown' },
      },
    });

    const asOperator = await rpc(
      served.keyed,
      'bureau.audit.query',
      { runId: resource },
      'operator-key',
    );
    const asStranger = await rpc(
      served.keyed,
      'bureau.audit.query',
      { runId: resource },
      'alice-key',
    );

    expect(listOf(asOperator as never, 'records')).toEqual([
      expect.objectContaining({
        type: 'tool.source.connected',
        resource,
        principal: ANONYMOUS_LOCAL_OWNER,
        detail: { sourceId: 'files', commandLine: 'npx -y @example/files-server' },
      }),
    ]);
    expect(listOf(asStranger as never, 'records')).toEqual([]);
    expect(AUDIT_SYNTHETIC_OWNER_PREFIXES).toContain('tool-source:');
  });

  it('shows the agent files a removal left invalid, as scalars', async () => {
    const served = await serve();
    const trail = served.bureau.internals.auditTrail;
    if (trail === undefined) throw new Error('The Bureau keeps no audit trail.');
    const resource = auditTrailToolSourceOwnerId('files');
    await trail.record({
      runId: resource,
      type: 'tool.source.removed',
      principal: ANONYMOUS_LOCAL_OWNER,
      detail: {
        sourceId: 'files',
        affectedAgents: 'approver,reader',
        affectedAgentCount: 2,
        agents: [{ id: 'never-shown' }],
      },
    });

    const asOperator = await rpc(
      served.keyed,
      'bureau.audit.query',
      { runId: resource },
      'operator-key',
    );

    expect(listOf(asOperator as never, 'records')).toEqual([
      expect.objectContaining({
        type: 'tool.source.removed',
        detail: { sourceId: 'files', affectedAgents: 'approver,reader', affectedAgentCount: 2 },
      }),
    ]);
  });
});

describe('bureau.agents.catalog', () => {
  const refund = createTool({
    name: 'issue-refund',
    description: 'Refunds an order',
    input: z.object({ orderId: z.string(), cents: z.number() }),
    metadata: { mutates: true },
    execute: async () => 'refunded',
  });
  const lookup = createTool({
    name: 'lookup-order',
    description: 'Looks an order up',
    input: z.object({ orderId: z.string() }),
    metadata: { readOnly: true },
    execute: async () => 'order',
  });
  const wipe = createTool({
    name: 'wipe-orders',
    description: 'Deletes every order',
    input: z.object({}),
    metadata: { dangerous: true },
    execute: async () => 'wiped',
  });

  async function serveTools() {
    const directory = await mkdtemp(join(tmpdir(), 'bureau-tool-catalog-'));
    roots.push(directory);
    return serve({
      directory,
      agents: {
        alpha: alpha(),
        // A code-defined agent that names a catalog tool uses it.
        clerk: createAgent({
          name: 'clerk',
          generate: async () => ({ content: 'x', toolCalls: [] }),
          tools: { 'lookup-order': lookup },
        }),
      },
      overrides: {
        agentSource: agentFileDirectory(directory, {
          tools: { 'lookup-order': lookup, 'issue-refund': refund, 'wipe-orders': wipe },
        }),
      },
    });
  }

  it('returns the schema, tier, default approval, source, and users of every tool', async () => {
    const served = await serveTools();
    await served.put(
      'support.md',
      agentFileText(
        { name: 'Support', model: KNOWN_MODEL, tools: '[lookup-order, issue-refund]' },
        'Help.\n',
      ),
    );
    await served.bureau.agents.refresh();

    const response = await callAs(served.local, 'bureau.agents.catalog', {});

    const tools = listOf(response, 'tools');
    const byName = Object.fromEntries(tools.map((tool) => [String(tool['name']), tool]));
    expect(Object.keys(byName).toSorted()).toEqual([
      'bureau:discover-agents',
      'issue-refund',
      'lookup-order',
      'settings-get',
      'settings-update',
      'wipe-orders',
    ]);
    // Every tool states a schema, a default approval, a source, and its users.
    for (const tool of tools) {
      expect(tool['inputSchema']).toMatchObject({ type: 'object' });
      expect(['allow', 'ask']).toContain(String(tool['defaultApproval']));
      expect(['host', 'bureau', 'plugin']).toContain(String(tool['source']));
      expect(Array.isArray(tool['users'])).toBe(true);
    }
    expect(byName['lookup-order']).toMatchObject({
      tier: 'read-only',
      defaultApproval: 'allow',
      source: 'host',
      users: ['clerk', 'support'],
    });
    expect(byName['lookup-order']).toMatchObject({
      inputSchema: { properties: { orderId: { type: 'string' } } },
    });
    expect(byName['issue-refund']).toMatchObject({
      tier: 'mutating',
      defaultApproval: 'ask',
      source: 'host',
      users: ['support'],
    });
    expect(byName['wipe-orders']).toMatchObject({
      tier: 'dangerous',
      defaultApproval: 'ask',
      users: [],
    });
    // Bureau's own tools are in the catalog, as Bureau's.
    expect(byName['settings-update']).toMatchObject({ source: 'bureau', users: [] });
    expect(byName['settings-get']).toMatchObject({ source: 'bureau' });
  });

  it('never reads a tool that declares nothing as read-only', async () => {
    const plain = createTool({
      name: 'plain-tool',
      description: 'Declares nothing',
      input: z.object({}),
      execute: async () => 'done',
    });
    const directory = await mkdtemp(join(tmpdir(), 'bureau-tool-catalog-plain-'));
    roots.push(directory);
    const served = await serve({
      directory,
      overrides: { agentSource: agentFileDirectory(directory, { tools: { 'plain-tool': plain } }) },
    });

    const response = await callAs(served.local, 'bureau.agents.catalog', {});

    const tool = listOf(response, 'tools').find((entry) => entry['name'] === 'plain-tool');
    expect(tool).toMatchObject({ tier: null, defaultApproval: 'ask' });
  });

  it('drops a user when the agent file is gone', async () => {
    const served = await serveTools();
    await served.put(
      'support.md',
      agentFileText({ name: 'Support', model: KNOWN_MODEL, tools: '[issue-refund]' }, 'Help.\n'),
    );
    await served.bureau.agents.refresh();
    const withFile = await callAs(served.local, 'bureau.agents.catalog', {});
    expect(
      listOf(withFile, 'tools').find((tool) => tool['name'] === 'issue-refund')?.['users'],
    ).toEqual(['support']);

    await rm(join(served.directory, 'support.md'));
    await served.bureau.agents.refresh();

    const without = await callAs(served.local, 'bureau.agents.catalog', {});
    expect(
      listOf(without, 'tools').find((tool) => tool['name'] === 'issue-refund')?.['users'],
    ).toEqual([]);
  });
});

describe('bureau.agents.definitions.get for a code-defined agent', () => {
  it('reads back its instructions, model, tools, and skills', async () => {
    const sources = await twoSources();
    const catalog = await discoverSkills({ sources, trustPolicy: admitSources([]), now });
    const served = await serve({
      agents: {
        alpha: alpha(),
        researcher: createAgent({
          name: 'Researcher',
          description: 'Finds things out',
          generate: async () => ({ content: 'x', toolCalls: [] }),
          instructions: 'You are careful.\nCite sources.',
          tools: { 'lookup-order': createTool(lookupToolConfiguration) },
          skills: createAgentSkills({ catalog }),
          skillDescriptors: [
            { id: 'research', name: 'Research', description: 'Looks things up', tags: ['search'] },
          ],
        }),
      },
    });

    const response = await callAs(served.local, 'bureau.agents.definitions.get', {
      id: 'researcher',
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      id: 'researcher',
      source: 'code',
      definition: null,
      text: null,
      codeDefinition: {
        name: 'Researcher',
        description: 'Finds things out',
        // The generate attaches no single model, so there is no default to name.
        model: null,
        models: [],
        instructions: 'You are careful.\nCite sources.',
        tools: ['lookup-order'],
        // Only what the agent can activate: the untrusted source's skill is not named.
        skills: ['summarize', 'translate'],
        skillDescriptors: [
          { id: 'research', name: 'Research', description: 'Looks things up', tags: ['search'] },
        ],
      },
    });
  });

  it('names the model a fixed agent attaches, and states nothing an agent does not declare', async () => {
    const opus = createModelCatalog().descriptors.find(
      (row) => row.provider === 'anthropic' && row.model === 'claude-opus-5',
    );
    if (opus === undefined) throw new Error('The model catalog has no claude-opus-5.');
    const served = await serve({
      agents: {
        alpha: alpha(),
        fixed: createAgent({
          name: 'fixed',
          generate: withBackendDescriptors(async () => ({ content: 'x', toolCalls: [] }), [opus]),
        }),
      },
    });

    const response = await callAs(served.local, 'bureau.agents.definitions.get', { id: 'fixed' });

    expect(response.result?.['codeDefinition']).toEqual({
      name: 'fixed',
      description: null,
      model: 'anthropic/claude-opus-5',
      models: ['anthropic/claude-opus-5'],
      instructions: null,
      tools: [],
      skills: [],
      skillDescriptors: [],
    });
  });

  it('leaves a file agent’s codeDefinition null', async () => {
    const served = await serve();
    await served.put(
      'writer.md',
      agentFileText({ name: 'Writer', model: KNOWN_MODEL, tools: '[lookup-order]' }, 'Write.\n'),
    );
    await served.bureau.agents.refresh();

    const response = await callAs(served.local, 'bureau.agents.definitions.get', { id: 'writer' });

    expect(response.result?.['codeDefinition']).toBeNull();
    expect(response.result?.['definition']).toMatchObject({ instructions: 'Write.\n' });
  });
});

const lookupToolConfiguration = {
  name: 'lookup-order',
  description: 'Looks an order up',
  input: z.object({}),
  execute: async () => 'order',
};
