/**
 * COR-1818: the host reads the `skills` sources in `configuration.json`, hands the catalog to
 * `bureau.skills.list`, refuses an untrusted skill, and changes a source's trust through the
 * configuration queue with an audit record. Every skill is a fixture written for the test.
 */
import { ANONYMOUS_LOCAL_OWNER, auditTrailSkillSourceOwnerId } from '@lostgradient/bureau';
import {
  createFilesystemArtifactLoader,
  createSkillClient,
  type SkillCatalogRevision,
} from '@lostgradient/bureau/skills';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeProviderHome } from './fake-provider.test-support.ts';
import { startHost, type Host } from './host.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { discoverFirstSkills, SkillInputError } from './skill-manager.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function writeSkill(root: string, name: string, allowedTools?: string): Promise<void> {
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

type Layout = {
  readonly home: string;
  readonly userSkills: string;
  readonly projectSkills: string;
};

/** A home whose configuration names a user source and a project source and trusts neither. */
async function layout(extra: Record<string, unknown> = {}): Promise<Layout> {
  const home = await scratch('interborough-skills-home-');
  const userSkills = await scratch('interborough-skills-user-');
  const projectSkills = await scratch('interborough-skills-project-');
  await writeSkill(userSkills, 'summarize', 'read_file grep');
  await writeSkill(projectSkills, 'deploy', 'run_shell');
  await writeFile(
    join(home, 'configuration.json'),
    JSON.stringify({
      ...extra,
      skills: {
        sources: [
          { id: 'home', kind: 'user', path: userSkills },
          { id: 'workspace', kind: 'project', path: projectSkills },
        ],
      },
    }),
  );
  return { home, userSkills, projectSkills };
}

async function startAt(home: string): Promise<Host> {
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  hosts.push(host);
  return host;
}

async function listSkills(host: Host) {
  const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.skills.list', params: {} }),
  });
  const body = (await response.json()) as {
    result?: {
      revision: number;
      skills: Array<Record<string, unknown>>;
      sources: Array<Record<string, unknown>>;
      trustLocked: string | null;
    };
    error?: unknown;
  };
  if (body.result === undefined) throw new Error(`bureau.skills.list failed: ${response.status}`);
  return body.result;
}

/** The skills the host listed, as `bureau.skills.list` answers them. */
async function rpc(host: Host, method: string, params: Record<string, unknown>) {
  const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await response.json()) as { result?: unknown; error?: { message: string } };
}

async function skillsOf(host: Host) {
  const listed = await listSkills(host);
  return listed.skills;
}

/** The `skills` key of the configuration file as it is on disk. */
async function savedSkills(home: string): Promise<unknown> {
  const configuration = await configurationOf(home);
  return configuration['skills'];
}

async function configurationOf(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(home, 'configuration.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function clientOver(catalog: SkillCatalogRevision) {
  return createSkillClient({ catalog, loadArtifact: createFilesystemArtifactLoader() });
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('skills in configuration.json', () => {
  test('lists the configured skills, none of them trusted until `trusted` names their source, whatever its kind', async () => {
    const { home, userSkills } = await layout();
    const host = await startAt(home);

    const listed = await listSkills(host);

    expect(listed.trustLocked).toBeNull();
    expect(listed.skills).toEqual([
      expect.objectContaining({
        name: 'deploy',
        source: expect.objectContaining({ id: 'workspace', kind: 'project' }),
        trust: 'untrusted',
        available: false,
        unavailableReason: 'source-untrusted',
        allowedTools: ['run_shell'],
      }),
      expect.objectContaining({
        name: 'summarize',
        source: { id: 'home', kind: 'user', location: userSkills, plugin: null },
        trust: 'untrusted',
        available: false,
        unavailableReason: 'source-untrusted',
        allowedTools: ['read_file', 'grep'],
      }),
    ]);
    expect(
      listed.sources.map((source) => [source['id'], source['trust'], source['skillCount']]),
    ).toEqual([
      ['home', 'untrusted', 1],
      ['workspace', 'untrusted', 1],
    ]);
  });

  test('trusts the sources `trusted` lists, and refuses an activation of the others with source-untrusted', async () => {
    const { home, userSkills, projectSkills } = await layout();
    await writeFile(
      join(home, 'configuration.json'),
      JSON.stringify({
        skills: {
          sources: [
            { id: 'home', kind: 'user', path: userSkills },
            { id: 'workspace', kind: 'project', path: projectSkills },
          ],
          trusted: ['home'],
        },
      }),
    );
    const host = await startAt(home);

    const client = clientOver(host.skills.standing().catalog);

    expect(await client.activate('deploy')).toMatchObject({
      activated: false,
      refusal: 'source-untrusted',
    });
    expect(await client.activate('summarize')).toMatchObject({ activated: true });
    const listed = await listSkills(host);
    expect(listed.skills.map((skill) => [skill['name'], skill['trust']])).toEqual([
      ['deploy', 'untrusted'],
      ['summarize', 'trusted'],
    ]);
  });

  test('lets a file agent be granted a trusted skill, and refuses an untrusted one (COR-1975)', async () => {
    const { home, userSkills, projectSkills } = await layout();
    await writeProviderHome(home);
    await writeFile(
      join(home, 'configuration.json'),
      JSON.stringify({
        ...(await configurationOf(home)),
        skills: {
          sources: [
            { id: 'home', kind: 'user', path: userSkills },
            { id: 'workspace', kind: 'project', path: projectSkills },
          ],
          trusted: ['home'],
        },
      }),
    );
    const host = await startAt(home);
    const create = (id: string, allowedSkills: readonly string[]) =>
      rpc(host, 'bureau.agents.definitions.create', {
        id,
        definition: { model: 'anthropic/sonnet', instructions: 'Help.', allowedSkills },
      });

    const granted = await create('granted', ['summarize']);
    expect(granted.error).toBeUndefined();
    const refused = await create('refused', ['deploy']);
    expect(refused.error?.message).toContain('source-untrusted');
  });

  test('discovers the configured skills and the plugins’ before the Bureau exists (COR-1975)', async () => {
    const { home, userSkills, projectSkills } = await layout();
    const pluginSkills = await scratch('interborough-skills-plugin-');
    await writeSkill(pluginSkills, 'plugged');
    const bungalow = {
      mode: 'local' as const,
      configurationLocation: join(home, 'configuration.json'),
      readConfiguration: async () =>
        JSON.stringify({
          skills: {
            sources: [
              { id: 'home', kind: 'user', path: userSkills },
              { id: 'workspace', kind: 'project', path: projectSkills },
            ],
            trusted: ['home'],
          },
        }),
      writeConfiguration: async () => {},
    };
    const catalog = await discoverFirstSkills({
      bungalow,
      pluginSources: () => [
        { id: 'plugin:p', kind: 'plugin', location: pluginSkills, precedence: 35, plugin: 'p' },
      ],
    });
    expect(Object.fromEntries(catalog.records.map((r) => [r.name, r.available]))).toEqual({
      deploy: false,
      plugged: true,
      summarize: true,
    });

    const failure = await failureOf(
      discoverFirstSkills({
        bungalow: {
          ...bungalow,
          readConfiguration: () => Promise.reject(new Error('down')),
        },
      }),
    );
    expect(failure).toBeInstanceOf(ProviderConfigurationError);
  });

  test('loads a configuration written before the key existed, and lists no skills', async () => {
    const home = await scratch('interborough-skills-old-');
    await writeFile(join(home, 'configuration.json'), JSON.stringify({ providers: {} }));
    const host = await startAt(home);

    const listed = await listSkills(host);

    expect(listed).toEqual({ revision: 1, skills: [], sources: [], trustLocked: null });
  });

  test('loads a home with no configuration file at all', async () => {
    const home = await scratch('interborough-skills-none-');
    const host = await startAt(home);

    expect(await skillsOf(host)).toEqual([]);
  });

  test.each([
    ['a source that is not an object', { sources: ['x'] }, 'skills.sources[0]'],
    [
      'an unknown kind',
      { sources: [{ id: 'a', kind: 'remote', path: '/tmp/skills' }] },
      'skills.sources[0].kind',
    ],
    [
      'a relative path',
      { sources: [{ id: 'a', kind: 'user', path: 'skills' }] },
      'skills.sources[0].path',
    ],
    [
      'a repeated identifier',
      {
        sources: [
          { id: 'a', kind: 'user', path: '/tmp/one' },
          { id: 'a', kind: 'user', path: '/tmp/two' },
        ],
      },
      'skills.sources[1].id',
    ],
    [
      'a trusted identifier no source has',
      { sources: [{ id: 'a', kind: 'user', path: '/tmp/one' }], trusted: ['b'] },
      'skills.trusted[0]',
    ],
    ['an unknown field', { sources: [], extra: true }, 'skills.extra'],
  ])('stops a host whose configuration has %s, naming the field', async (_name, skills, field) => {
    const home = await scratch('interborough-skills-invalid-');
    await writeFile(join(home, 'configuration.json'), JSON.stringify({ skills }));

    const failure = await failureOf(startAt(home));

    expect(failure).toBeInstanceOf(ProviderConfigurationError);
    expect((failure as ProviderConfigurationError).field).toBe(field);
  });
});

describe('changing the trust of a source', () => {
  test('writes `trusted` to the file, applies it at once, and audits it with the owner', async () => {
    const { home } = await layout({ providers: {} });
    const host = await startAt(home);
    const before = host.skills.standing().catalog.revision;

    const change = await host.skills.setTrust({ source: 'workspace', trusted: true });

    expect(change).toEqual({
      source: 'workspace',
      trusted: true,
      changed: true,
      revision: before + 1,
    });
    // Persisted, and the rest of the file is as it was.
    const written = await configurationOf(home);
    expect(written['providers']).toEqual({});
    expect(written['skills']).toMatchObject({ trusted: ['workspace'] });
    // Applied: the next list reads it, and a client built over the new revision activates it.
    const listed = await listSkills(host);
    expect(listed.skills.find((skill) => skill['name'] === 'deploy')).toMatchObject({
      trust: 'trusted',
      available: true,
    });
    expect(await clientOver(host.skills.standing().catalog).activate('deploy')).toMatchObject({
      activated: true,
    });
    // Audited, filed under the source, made by the owner.
    const trail = await host.bureau.audit.query({
      runId: auditTrailSkillSourceOwnerId('workspace'),
    });
    expect(trail.records).toEqual([
      expect.objectContaining({
        type: 'skill.source.trusted',
        resource: 'skill-source:workspace',
        principal: ANONYMOUS_LOCAL_OWNER,
        detail: { sourceId: 'workspace', trusted: true },
      }),
    ]);
  });

  test('refuses a revoked source at the next use by a run that started before the revocation (COR-1926)', async () => {
    const { home } = await layout();
    const host = await startAt(home);
    await host.skills.setTrust({ source: 'workspace', trusted: true });
    // A run: bound to the catalog it started with, and checking the host's catalog at each use.
    const run = createSkillClient({
      catalog: host.skills.standing().catalog,
      currentCatalog: () => host.skills.standing().catalog,
      loadArtifact: createFilesystemArtifactLoader(),
    });
    expect(await run.activate('deploy')).toMatchObject({ activated: true });

    await host.skills.setTrust({ source: 'workspace', trusted: false });

    expect(run.active()).toEqual([]);
    run.deactivate('deploy');
    expect(await run.activate('deploy')).toMatchObject({
      activated: false,
      refusal: 'source-untrusted',
    });

    await host.skills.setTrust({ source: 'workspace', trusted: true });
    expect(await run.activate('deploy')).toMatchObject({ activated: true });
  });

  test('survives a restart, and stopping trust is audited too', async () => {
    const { home } = await layout();
    const first = await startAt(home);
    await first.skills.setTrust({ source: 'home', trusted: true });
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    const second = await startAt(home);
    const restarted = await skillsOf(second);
    expect(restarted.find((skill) => skill['name'] === 'summarize')).toMatchObject({
      trust: 'trusted',
    });
    const revoked = await second.skills.setTrust({ source: 'home', trusted: false });

    expect(revoked.changed).toBe(true);
    expect(await savedSkills(home)).toMatchObject({ trusted: [] });
    const trail = await second.bureau.audit.query({ runId: auditTrailSkillSourceOwnerId('home') });
    // The trail outlives the restart, so the earlier trust is still on it, in order.
    expect(trail.records.map((record) => record.type)).toEqual([
      'skill.source.trusted',
      'skill.source.untrusted',
    ]);
  });

  test('changes nothing, writes nothing and audits nothing when the source already has that trust', async () => {
    const { home } = await layout();
    const host = await startAt(home);
    const before = await readFile(join(home, 'configuration.json'), 'utf8');

    const change = await host.skills.setTrust({ source: 'workspace', trusted: false });

    expect(change.changed).toBe(false);
    expect(await readFile(join(home, 'configuration.json'), 'utf8')).toBe(before);
    const trail = await host.bureau.audit.query({
      runId: auditTrailSkillSourceOwnerId('workspace'),
    });
    expect(trail.records).toEqual([]);
  });

  test('refuses a source the configuration does not list, and a trusted value that is not a boolean', async () => {
    const { home } = await layout();
    const host = await startAt(home);

    const unknown = await failureOf(host.skills.setTrust({ source: 'nowhere', trusted: true }));
    const wrong = await failureOf(host.skills.setTrust({ source: 'home', trusted: 'yes' }));

    expect(unknown).toBeInstanceOf(SkillInputError);
    expect((unknown as SkillInputError).kind).toBe('unknown-source');
    expect(wrong).toBeInstanceOf(SkillInputError);
    expect((wrong as SkillInputError).field).toBe('trusted');
  });

  test('keeps two overlapping changes, because each starts from the file the other wrote', async () => {
    const { home } = await layout();
    const host = await startAt(home);

    await Promise.all([
      host.skills.setTrust({ source: 'home', trusted: true }),
      host.skills.setTrust({ source: 'workspace', trusted: true }),
    ]);

    const saved = (await savedSkills(home)) as { trusted: string[] };
    expect(saved.trusted).toEqual(['home', 'workspace']);
    const all = await skillsOf(host);
    expect(all.every((skill) => skill['trust'] === 'trusted')).toBe(true);
  });

  test('shares the host’s configuration queue with a writer of its own', async () => {
    const { home } = await layout();
    const host = await startAt(home);
    const order: string[] = [];

    const own = host.configurationQueue.run(async () => {
      order.push('own-start');
      await Promise.resolve();
      order.push('own-end');
    });
    const change = host.skills.setTrust({ source: 'home', trusted: true }).then(() => {
      order.push('trust');
    });
    await Promise.all([own, change]);

    expect(order).toEqual(['own-start', 'own-end', 'trust']);
  });

  test('refreshes the catalog when a person adds a skill by hand', async () => {
    const { home, userSkills } = await layout();
    const host = await startAt(home);
    await writeSkill(userSkills, 'translate');

    const refreshed = await host.skills.refresh();

    expect(refreshed.revision).toBe(2);
    const names = await skillsOf(host);
    expect(names.map((skill) => skill['name'])).toContain('translate');
  });
});

describe('the skill routes', () => {
  async function send(host: Host, method: string, path: string, body?: unknown) {
    return fetch(new URL(path, host.url), {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  }

  test('trust a source, and report the change', async () => {
    const { home } = await layout();
    const host = await startAt(home);

    const response = await send(host, 'PUT', '/host/skills/sources/workspace/trust', {
      trusted: true,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: 'workspace',
      trusted: true,
      changed: true,
    });
    expect(await savedSkills(home)).toMatchObject({ trusted: ['workspace'] });
  });

  test('answers 404 for an unknown source and 400 for a body that cannot be used', async () => {
    const { home } = await layout();
    const host = await startAt(home);

    const unknown = await send(host, 'PUT', '/host/skills/sources/nowhere/trust', {
      trusted: true,
    });
    const notJson = await send(host, 'PUT', '/host/skills/sources/home/trust', '{ nope');
    const notBoolean = await send(host, 'PUT', '/host/skills/sources/home/trust', {
      trusted: 'yes',
    });

    expect(unknown.status).toBe(404);
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: 'invalid', field: 'body' });
    expect(notBoolean.status).toBe(400);
    expect(await notBoolean.json()).toMatchObject({ field: 'trusted' });
  });

  test('answers 500 partial when the audit write fails, and the same request again records it (COR-1926)', async () => {
    const { home } = await layout();
    const host = await startAt(home);
    const trail = host.bureau.internals.auditTrail!;
    const record = trail.record.bind(trail);
    // A trail that is down honors `strict`: it rejects for a caller that asked to be told, and
    // drops the record for any other, which is what the default path does with a storage failure.
    let down = true;
    spyOn(trail, 'record').mockImplementation(async (entry) => {
      if (down) {
        if (entry.strict === true) throw new Error('the trail is down');
        return;
      }
      await record(entry);
    });

    const failed = await send(host, 'PUT', '/host/skills/sources/workspace/trust', {
      trusted: true,
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({
      error: 'partial',
      source: 'workspace',
      trusted: true,
    });
    expect(await savedSkills(home)).toMatchObject({ trusted: ['workspace'] });

    down = false;
    const retried = await send(host, 'PUT', '/host/skills/sources/workspace/trust', {
      trusted: true,
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ trusted: true, changed: false });
    const records = await host.bureau.audit.query({
      runId: auditTrailSkillSourceOwnerId('workspace'),
    });
    expect(records.records.map((entry) => entry.type)).toEqual(['skill.source.trusted']);
  });

  test('refresh answers the catalog revision', async () => {
    const { home } = await layout();
    const host = await startAt(home);

    const response = await send(host, 'POST', '/host/skills/refresh');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 2 });
  });

  test('refuse a request from another origin, as every host route does', async () => {
    const { home } = await layout();
    const host = await startAt(home);

    const response = await fetch(new URL('/host/skills/sources/home/trust', host.url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ trusted: true }),
    });

    expect(response.status).toBe(403);
    expect(await savedSkills(home)).not.toHaveProperty('trusted');
  });
});
