/**
 * COR-1526 — `bureau.agents.definitions.*` and `bureau.agents.catalog` over a real Bureau and its
 * handler: the owner predicate and the operator scopes on every operation (a black-box test with
 * several principals, over the exported list so a later operation is covered without editing
 * it), each operation's results and typed faults, the audit trail, and publication.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createModelCatalog,
  projectDescriptor,
  type BackendDescriptor,
} from '@lostgradient/operative';
import {
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
  createOperationHandler,
  unauthenticatedLocalAuthContext,
  type AuthenticatedPrincipal,
} from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from '../../create-bureau.ts';
import { createModelCatalogService } from '../../model-catalog-refresh.ts';
import {
  agentFileText,
  KNOWN_MODEL,
  OTHER_MODEL,
} from '../../testing/agent-file-fixtures.test-support.ts';
import {
  type FileBureauHarness,
  startFileBureau,
} from '../../testing/agent-file-bureau.test-support.ts';
import { typesOf, readAgUiStream } from '../ag-ui-stream.test-support.ts';
import { runAgentInput, startRequest } from '../ag-ui-fixtures.test-support.ts';
import { BUREAU_SCOPES } from '../bureau-scopes.ts';
import {
  buildBureauHandlerHost,
  BUREAU_HANDLER_OPERATIONS,
  createBureauHandler,
} from '../create-bureau-handler.ts';
import { bureauAgentDefinitionsOperations } from './agent-definitions-operations.ts';
import {
  authentication,
  rpc,
  type Handler,
  type RpcBody,
} from './management-fixtures.test-support.ts';

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

const RESEARCHER = agentFileText(
  { name: 'Researcher', model: KNOWN_MODEL, tools: '[lookup-order]' },
  'You are careful.\n',
);

/** The definition a caller sends to create or update an agent. */
const DEFINITION = {
  name: 'Writer',
  description: 'Writes things',
  model: KNOWN_MODEL,
  tools: ['lookup-order'],
  instructions: 'Write well.\n',
};

interface Served extends FileBureauHarness {
  /** Serves API-key callers, by the key the management fixtures define. */
  readonly keyed: Handler;
  /** Serves one `unauthenticated-local` caller who holds no Bureau scope: the owner, with no operator scope. */
  readonly owner: Handler;
  /** Serves one `unauthenticated-local` caller who holds every Bureau scope. */
  readonly local: Handler;
  /** The hash of an agent's file as the catalog has it. */
  hashOf(id: string): string;
}

async function serve(options: Parameters<typeof startFileBureau>[0] = {}): Promise<Served> {
  const harness = await startFileBureau({
    ...options,
    overrides: { id: 'agents-bureau', ...options.overrides },
  });
  harnesses.push(harness);
  const { bureau } = harness;
  const keyed = createBureauHandler(bureau, { authentication, publish: ['alpha'] });
  const local = createBureauHandler(bureau, { unauthenticatedAccess: 'allow', publish: ['alpha'] });
  const noBureauScopes = new Set<AuthorizationScope>(
    [...(unauthenticatedLocalAuthContext().principal?.scopes ?? AUTHORIZATION_SCOPES)].filter(
      (scope) => !(BUREAU_SCOPES as readonly string[]).includes(scope),
    ),
  );
  const ownerPrincipal: AuthenticatedPrincipal = Object.freeze({
    method: 'unauthenticated-local',
    scopes: noBureauScopes,
    claims: undefined,
    subject: undefined,
    hasScope: (scope: AuthorizationScope) => noBureauScopes.has(scope),
  });
  const owner = createOperationHandler({
    operations: BUREAU_HANDLER_OPERATIONS,
    host: buildBureauHandlerHost(bureau, ['alpha']),
    authenticate: async () => ({
      method: 'unauthenticated-local' as const,
      principal: ownerPrincipal,
    }),
    publicPaths: [],
  });
  return {
    ...harness,
    keyed,
    owner,
    local,
    hashOf(id) {
      const hash = bureau.agents.list().find((listing) => listing.id === id)?.definitionHash;
      if (hash === undefined) throw new Error(`Expected a file for "${id}".`);
      return hash;
    },
  };
}

async function callAs(handler: Handler, method: string, params: unknown): Promise<RpcBody> {
  const response = await handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (await response.json()) as RpcBody;
}

/** The array an operation's result holds under `key`, empty when it holds none. */
function listOf(response: RpcBody, key: string): Array<Record<string, unknown>> {
  const value = response.result?.[key];
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/** Writes the researcher file by hand, runs it once, and waits for the catalog to reflect it. */
async function seed(served: Served): Promise<string> {
  await served.put('researcher.md', RESEARCHER);
  await served.bureau.agents.refresh();
  await served.bureau.run('researcher', 'hello').result();
  return served.hashOf('researcher');
}

const ownerPath = (served: Served, id = 'researcher') => join(served.directory, `${id}.md`);

describe('the operations list', () => {
  it('serves the nine agent definition operations, with their scopes registered', () => {
    expect(bureauAgentDefinitionsOperations.map((operation) => operation.name)).toEqual([
      'bureau.agents.definitions.create',
      'bureau.agents.definitions.update',
      'bureau.agents.definitions.publish',
      'bureau.agents.definitions.withdraw',
      'bureau.agents.definitions.delete',
      'bureau.agents.definitions.get',
      'bureau.agents.definitions.list',
      'bureau.agents.definitions.revisions',
      'bureau.agents.catalog',
    ]);
    expect(BUREAU_SCOPES).toContain('bureau.agents:read');
    expect(BUREAU_SCOPES).toContain('bureau.agents:write');
    for (const operation of bureauAgentDefinitionsOperations) {
      expect(BUREAU_HANDLER_OPERATIONS).toContain(operation);
    }
  });
});

type Call = {
  readonly method: string;
  readonly params: (hash: string) => unknown;
  readonly scope: 'read' | 'write';
  /** How a caller who may not use the operation is refused. */
  readonly denial: 'not-found' | 'empty-page' | 'forbidden';
};

const CALLS: readonly Call[] = [
  {
    method: 'bureau.agents.definitions.get',
    params: () => ({ id: 'researcher' }),
    scope: 'read',
    denial: 'not-found',
  },
  {
    method: 'bureau.agents.definitions.list',
    params: () => ({}),
    scope: 'read',
    denial: 'empty-page',
  },
  {
    method: 'bureau.agents.definitions.revisions',
    params: () => ({ id: 'researcher' }),
    scope: 'read',
    denial: 'not-found',
  },
  { method: 'bureau.agents.catalog', params: () => ({}), scope: 'read', denial: 'forbidden' },
  {
    method: 'bureau.agents.definitions.create',
    params: () => ({ id: 'another', definition: DEFINITION }),
    scope: 'write',
    denial: 'forbidden',
  },
  {
    method: 'bureau.agents.definitions.update',
    params: (hash) => ({
      id: 'researcher',
      expectedHash: hash,
      definition: { ...DEFINITION, name: 'Renamed' },
    }),
    scope: 'write',
    denial: 'not-found',
  },
  {
    method: 'bureau.agents.definitions.publish',
    params: (hash) => ({ id: 'researcher', expectedHash: hash }),
    scope: 'write',
    denial: 'not-found',
  },
  {
    method: 'bureau.agents.definitions.withdraw',
    params: (hash) => ({ id: 'researcher', expectedHash: hash }),
    scope: 'write',
    denial: 'not-found',
  },
  {
    method: 'bureau.agents.definitions.delete',
    params: (hash) => ({ id: 'researcher', expectedHash: hash }),
    scope: 'write',
    denial: 'not-found',
  },
];

describe('the owner predicate, with several principals', () => {
  it('covers every operation the module exports', () => {
    expect(CALLS.map((call) => call.method).toSorted()).toEqual(
      bureauAgentDefinitionsOperations.map((operation) => operation.name).toSorted(),
    );
  });

  for (const call of CALLS) {
    describe(call.method, () => {
      it('answers a caller who owns nothing and holds no scope as if no such agent existed, and changes nothing', async () => {
        const served = await serve();
        const hash = await seed(served);
        const before = await readFile(ownerPath(served), 'utf8');
        const response = await rpc(served.keyed, call.method, call.params(hash), 'alice-key');
        if (call.denial === 'empty-page') {
          expect(response.error).toBeUndefined();
          expect(response.result?.['agents']).toEqual([]);
          expect(response.result?.['nextOffset']).toBeNull();
        } else {
          expect(response.error?.data?.httpStatus).toBe(call.denial === 'forbidden' ? 403 : 404);
          expect(response.result).toBeUndefined();
        }
        expect(await readFile(ownerPath(served), 'utf8')).toBe(before);
        expect(served.bureau.agents.list().map((listing) => listing.id)).toEqual([
          'alpha',
          'researcher',
        ]);
        expect(await served.bureau.auditTrail?.query({ runId: 'agent:researcher' })).toEqual([]);
      });

      it(`is served to the operator scope for ${call.scope}, and not to the other scope`, async () => {
        const served = await serve();
        const hash = await seed(served);
        const allowedKey = call.scope === 'read' ? 'agents-reader-key' : 'agents-writer-key';
        const deniedKey = call.scope === 'read' ? 'agents-writer-key' : 'agents-reader-key';
        const denied = await rpc(served.keyed, call.method, call.params(hash), deniedKey);
        if (call.denial === 'empty-page') {
          expect(denied.result?.['agents']).toEqual([]);
        } else {
          expect(denied.error?.data?.httpStatus).toBe(call.denial === 'forbidden' ? 403 : 404);
        }
        const allowed = await rpc(served.keyed, call.method, call.params(hash), allowedKey);
        expect(allowed.error).toBeUndefined();
        expect(allowed.result).toBeDefined();
      });

      it('is served to the owner of the deployment’s agents with no scope at all', async () => {
        const served = await serve();
        const hash = await seed(served);
        const response = await callAs(served.owner, call.method, call.params(hash));
        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
      });

      it('is served to an operator who holds every Bureau scope', async () => {
        const served = await serve();
        const hash = await seed(served);
        const response = await rpc(served.keyed, call.method, call.params(hash), 'operator-key');
        expect(response.error).toBeUndefined();
      });
    });
  }

  it('lets an operator list, read, and command another principal’s agents, and nobody else', async () => {
    const served = await serve();
    const hash = await seed(served);
    const listed = await rpc(served.keyed, 'bureau.agents.definitions.list', {}, 'operator-key');
    expect(listOf(listed, 'agents').map((entry) => entry['id'])).toEqual(['alpha', 'researcher']);
    const got = await rpc(
      served.keyed,
      'bureau.agents.definitions.get',
      { id: 'researcher' },
      'operator-key',
    );
    expect(got.result).toMatchObject({ id: 'researcher', hash, owner: 'anonymous:local' });
    const published = await rpc(
      served.keyed,
      'bureau.agents.definitions.publish',
      { id: 'researcher', expectedHash: hash },
      'operator-key',
    );
    expect(published.error).toBeUndefined();
    // Neither of two principals without a scope sees it, however the other fared.
    for (const key of ['alice-key', 'bob-key']) {
      const denied = await rpc(
        served.keyed,
        'bureau.agents.definitions.get',
        { id: 'researcher' },
        key,
      );
      expect(denied.error?.data?.httpStatus).toBe(404);
    }
  });

  it('answers an identifier the same way whether or not the agent exists, to a caller who may not see it', async () => {
    const served = await serve();
    await seed(served);
    const real = await rpc(
      served.keyed,
      'bureau.agents.definitions.get',
      { id: 'researcher' },
      'alice-key',
    );
    const random = await rpc(
      served.keyed,
      'bureau.agents.definitions.get',
      { id: 'no-such-agent' },
      'alice-key',
    );
    expect(real.error?.data?.httpStatus).toBe(404);
    expect(JSON.stringify(real).replaceAll('researcher', '<id>')).toBe(
      JSON.stringify(random).replaceAll('no-such-agent', '<id>'),
    );
  });
});

describe('results', () => {
  it('creates a file a person could write by hand, and reads it back with its hash and state', async () => {
    const served = await serve();
    const created = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'writer',
      definition: DEFINITION,
    });
    expect(created.result?.['id']).toBe('writer');
    const text = await readFile(ownerPath(served, 'writer'), 'utf8');
    expect(text).toContain('model: anthropic/claude-opus-5-5');
    expect(text).toContain('published: false');
    expect(text.endsWith('Write well.\n')).toBe(true);

    const got = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'writer' });
    expect(got.result).toMatchObject({
      id: 'writer',
      source: 'file',
      state: 'ready',
      name: 'Writer',
      description: 'Writes things',
      published: false,
      owner: 'anonymous:local',
      hash: created.result?.['hash'],
      problem: null,
      text,
      definition: {
        name: 'Writer',
        description: 'Writes things',
        model: KNOWN_MODEL,
        tools: ['lookup-order'],
        skills: [],
        published: false,
        instructions: 'Write well.\n',
      },
    });
    // The agent is in the catalog, and runs, before the call returned.
    expect(served.bureau.agents.find('writer')).toBeDefined();
  });

  it('lists code-defined agents first, then files by identifier, with their state and hash, and pages', async () => {
    const served = await serve();
    await served.put('b-agent.md', agentFileText({ model: KNOWN_MODEL }));
    await served.put('a-agent.md', agentFileText({ model: KNOWN_MODEL }));
    await served.put('broken.md', agentFileText({ model: 'anthropic/none' }));
    await served.bureau.agents.refresh();
    const all = await callAs(served.owner, 'bureau.agents.definitions.list', {});
    expect(
      listOf(all, 'agents').map((entry) => [entry['id'], entry['source'], entry['state']]),
    ).toEqual([
      ['alpha', 'code', 'ready'],
      ['a-agent', 'file', 'ready'],
      ['b-agent', 'file', 'ready'],
      ['broken', 'file', 'invalid'],
    ]);
    const broken = listOf(all, 'agents').find((entry) => entry['id'] === 'broken');
    expect(broken).toMatchObject({
      hash: served.hashOf('broken'),
      problem: { code: 'unknown-model' },
    });
    expect(listOf(all, 'agents')[0]).toMatchObject({ hash: null, problem: null });

    const first = await callAs(served.owner, 'bureau.agents.definitions.list', { limit: 3 });
    expect(listOf(first, 'agents').length).toBe(3);
    expect(first.result?.['nextOffset']).toBe(3);
    const second = await callAs(served.owner, 'bureau.agents.definitions.list', {
      limit: 3,
      offset: 3,
    });
    expect(listOf(second, 'agents').map((entry) => entry['id'])).toEqual(['broken']);
    expect(second.result?.['nextOffset']).toBeNull();
  });

  it('reads an invalid file with its problem, its hash, and its exact text', async () => {
    const served = await serve();
    const text = agentFileText({ model: 'anthropic/none', owner: 'me' }, 'Body.\n');
    await served.put('broken.md', text);
    await served.bureau.agents.refresh();
    const got = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'broken' });
    expect(got.result).toMatchObject({
      state: 'invalid',
      text,
      hash: served.hashOf('broken'),
      problem: { code: 'unknown-model' },
    });
    // The frontmatter parsed, so the definition is shown beside the reason it cannot run.
    expect(got.result?.['definition']).toMatchObject({ model: 'anthropic/none' });
  });

  it('reads a code-defined agent, with no hash, text, or definition', async () => {
    const served = await serve();
    const got = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'alpha' });
    expect(got.result).toMatchObject({
      id: 'alpha',
      source: 'code',
      state: 'ready',
      hash: null,
      text: null,
      definition: null,
      owner: 'anonymous:local',
    });
  });

  it('updates a definition, keeps the keys Bureau does not know and whether the agent is published', async () => {
    const served = await serve();
    await served.put(
      'researcher.md',
      '---\nname: Researcher\nmodel: anthropic/claude-opus-5-5\npublished: true\ncreated: 2026-10-18\n---\nOriginal.\n',
    );
    await served.bureau.agents.refresh();
    const hash = served.hashOf('researcher');
    const updated = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: hash,
      definition: { model: OTHER_MODEL, name: 'Researcher', instructions: 'Rewritten.\n' },
    });
    expect(updated.error).toBeUndefined();
    const text = await readFile(ownerPath(served), 'utf8');
    expect(text).toContain('created: 2026-10-18');
    expect(text).toContain('published: true');
    expect(text).toContain(`model: ${OTHER_MODEL}`);
    expect(text.endsWith('Rewritten.\n')).toBe(true);
    expect(updated.result?.['hash']).toBe(served.hashOf('researcher'));
    const afterwards = await callAs(served.owner, 'bureau.agents.definitions.get', {
      id: 'researcher',
    });
    expect(afterwards.result).toMatchObject({ published: true });
  });

  it('writes nothing for an update that changes nothing, and returns the same hash', async () => {
    const served = await serve();
    const hash = await seed(served);
    const before = await readFile(ownerPath(served), 'utf8');
    const same = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: hash,
      definition: {
        name: 'Researcher',
        model: KNOWN_MODEL,
        tools: ['lookup-order'],
        instructions: 'You are careful.\n',
      },
    });
    expect(same.result?.['hash']).toBe(hash);
    expect(await readFile(ownerPath(served), 'utf8')).toBe(before);
    expect(await served.bureau.auditTrail?.query({ runId: 'agent:researcher' })).toEqual([]);
  });

  it('lists the revisions that have run, newest first, each with the definition it ran', async () => {
    const served = await serve();
    const first = await seed(served);
    const updated = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: first,
      definition: { name: 'Researcher', model: KNOWN_MODEL, instructions: 'Second.\n' },
    });
    // A revision saved and never run is not listed.
    expect(
      listOf(
        await callAs(served.owner, 'bureau.agents.definitions.revisions', { id: 'researcher' }),
        'revisions',
      ).length,
    ).toBe(1);
    await served.bureau.run('researcher', 'again').result();
    const revisions = listOf(
      await callAs(served.owner, 'bureau.agents.definitions.revisions', { id: 'researcher' }),
      'revisions',
    );
    expect(revisions.map((revision) => revision['hash'])).toEqual([
      updated.result?.['hash'],
      first,
    ]);
    expect(revisions[0]?.['definition']).toMatchObject({ instructions: 'Second.\n', tools: [] });
    expect(revisions[1]?.['definition']).toMatchObject({
      instructions: 'You are careful.\n',
      tools: ['lookup-order'],
    });
  });

  it('answers revisions for a code-defined agent with none, and for an unknown identifier with NotFound', async () => {
    const served = await serve();
    const code = await callAs(served.owner, 'bureau.agents.definitions.revisions', {
      id: 'alpha',
    });
    expect(code.result?.['revisions']).toEqual([]);
    const unknown = await callAs(served.owner, 'bureau.agents.definitions.revisions', {
      id: 'nobody',
    });
    expect(unknown.error?.data?.httpStatus).toBe(404);
  });
});

describe('publication', () => {
  it('sets published in the frontmatter and nothing else, and a withdrawn agent is not published', async () => {
    const served = await serve();
    await served.put(
      'researcher.md',
      '---\nmodel: anthropic/claude-opus-5-5\n# a comment\ncreated: 2026-10-18\n---\n  Body kept.\n',
    );
    await served.bureau.agents.refresh();
    const hash = served.hashOf('researcher');
    const published = await callAs(served.owner, 'bureau.agents.definitions.publish', {
      id: 'researcher',
      expectedHash: hash,
    });
    const text = await readFile(ownerPath(served), 'utf8');
    // A file with no `name` key gains no `name`, and the comment and the body are untouched.
    expect(text).toBe(
      '---\nmodel: anthropic/claude-opus-5-5\n# a comment\ncreated: 2026-10-18\npublished: true\n---\n  Body kept.\n',
    );
    expect(published.result?.['hash']).toBe(served.hashOf('researcher'));

    const withdrawn = await callAs(served.owner, 'bureau.agents.definitions.withdraw', {
      id: 'researcher',
      expectedHash: published.result?.['hash'],
    });
    expect(await readFile(ownerPath(served), 'utf8')).toBe(
      '---\nmodel: anthropic/claude-opus-5-5\n# a comment\ncreated: 2026-10-18\npublished: false\n---\n  Body kept.\n',
    );
    expect(withdrawn.error).toBeUndefined();
  });

  it('writes nothing, and returns the same hash, to publish a published agent or withdraw a withdrawn one', async () => {
    const served = await serve();
    const hash = await seed(served);
    const withdrawn = await callAs(served.owner, 'bureau.agents.definitions.withdraw', {
      id: 'researcher',
      expectedHash: hash,
    });
    expect(withdrawn.result?.['hash']).toBe(hash);
    const published = await callAs(served.owner, 'bureau.agents.definitions.publish', {
      id: 'researcher',
      expectedHash: hash,
    });
    const again = await callAs(served.owner, 'bureau.agents.definitions.publish', {
      id: 'researcher',
      expectedHash: published.result?.['hash'],
    });
    expect(again.result?.['hash']).toBe(published.result?.['hash']);
    // One real write (the publish) was audited; the two no-ops were not.
    const entries = await served.bureau.auditTrail?.query({ runId: 'agent:researcher' });
    expect(entries?.map((entry) => entry.type)).toEqual(['agent.published']);
  });

  it('lists a published persisted agent in bureau.agents.list as published and a withdrawn one as withdrawn', async () => {
    const served = await serve();
    const hash = await seed(served);
    const before = await callAs(served.local, 'bureau.agents.list', {});
    // The allowlist names the code-defined `alpha`; the file is withdrawn until it is published.
    expect(listOf(before, 'agents').map((entry) => [entry['name'], entry['publishState']])).toEqual(
      [
        ['alpha', 'published'],
        ['researcher', 'withdrawn'],
      ],
    );

    const published = await callAs(served.local, 'bureau.agents.definitions.publish', {
      id: 'researcher',
      expectedHash: hash,
    });
    const during = await callAs(served.local, 'bureau.agents.list', {});
    expect(listOf(during, 'agents').map((entry) => [entry['name'], entry['publishState']])).toEqual(
      [
        ['alpha', 'published'],
        ['researcher', 'published'],
      ],
    );
    expect(listOf(during, 'agents')[1]).toMatchObject({
      displayName: 'Researcher',
      description: null,
    });
    const deployment = await callAs(served.local, 'bureau.deployment.get', {});
    expect(deployment.result?.['publishedAgents']).toEqual(['alpha', 'researcher']);

    await callAs(served.local, 'bureau.agents.definitions.withdraw', {
      id: 'researcher',
      expectedHash: published.result?.['hash'],
    });
    const after = await callAs(served.local, 'bureau.agents.list', {});
    expect(listOf(after, 'agents').map((entry) => [entry['name'], entry['publishState']])).toEqual([
      ['alpha', 'published'],
      ['researcher', 'withdrawn'],
    ]);
    const deploymentAfter = await callAs(served.local, 'bureau.deployment.get', {});
    expect(deploymentAfter.result?.['publishedAgents']).toEqual(['alpha']);
  });

  it('keeps the allowlist as the only way to publish a code-defined agent', async () => {
    const served = await serve();
    const handler = createBureauHandler(served.bureau, { unauthenticatedAccess: 'allow' });
    const none = await callAs(handler, 'bureau.agents.list', {});
    expect(none.result?.['agents']).toEqual([]);
    const refused = await callAs(handler, 'bureau.agents.definitions.publish', {
      id: 'alpha',
      expectedHash: 'x',
    });
    expect(refused.error?.data?.httpStatus).toBe(404);
  });

  it('lets the AG-UI mount start a published persisted agent and refuses a withdrawn one', async () => {
    const served = await serve();
    const hash = await seed(served);
    const handler = createBureauHandler(served.bureau, {
      unauthenticatedAccess: 'allow',
      agUi: {},
    });
    const start = async (threadId: string) =>
      typesOf(
        await readAgUiStream(
          await handler(startRequest(runAgentInput({ threadId }), {}, 'researcher')),
        ),
      );
    expect(await start('thread-withdrawn')).toEqual(['RUN_ERROR']);
    const published = await callAs(handler, 'bureau.agents.definitions.publish', {
      id: 'researcher',
      expectedHash: hash,
    });
    expect(await start('thread-published')).toContain('RUN_FINISHED');
    await callAs(handler, 'bureau.agents.definitions.withdraw', {
      id: 'researcher',
      expectedHash: published.result?.['hash'],
    });
    expect(await start('thread-withdrawn-again')).toEqual(['RUN_ERROR']);
  });
});

describe('delete', () => {
  it('removes the file and withdraws the agent, and keeps its revisions while its runs are retained', async () => {
    const served = await serve();
    const hash = await seed(served);
    const deleted = await callAs(served.owner, 'bureau.agents.definitions.delete', {
      id: 'researcher',
      expectedHash: hash,
    });
    expect(deleted.error).toBeUndefined();
    await served.bureau.agents.refresh();
    expect(served.bureau.agents.find('researcher')).toBeUndefined();
    const gone = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'researcher' });
    expect(gone.error?.data?.httpStatus).toBe(404);
    // The run that began on the file is retained, so the snapshot it began on is too.
    const revisions = await callAs(served.owner, 'bureau.agents.definitions.revisions', {
      id: 'researcher',
    });
    expect(listOf(revisions, 'revisions').map((revision) => revision['hash'])).toEqual([hash]);
  });
});

describe('code-defined agents', () => {
  it('are refused not-found-shaped when updated, published, withdrawn, or deleted', async () => {
    const served = await serve();
    for (const [method, extra] of [
      ['update', { definition: DEFINITION }],
      ['publish', {}],
      ['withdraw', {}],
      ['delete', {}],
    ] as const) {
      for (const handler of [served.owner, served.local]) {
        const response = await callAs(handler, `bureau.agents.definitions.${method}`, {
          id: 'alpha',
          expectedHash: 'x',
          ...extra,
        });
        expect([method, response.error?.data?.httpStatus]).toEqual([method, 404]);
      }
    }
    expect(served.bureau.agents.find('alpha')).toBeDefined();
  });

  it('keep their key against a create, as a taken identifier', async () => {
    const served = await serve();
    const response = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'alpha',
      definition: DEFINITION,
    });
    expect(response.error?.data?.httpStatus).toBe(409);
    expect(response.error?.data).toMatchObject({ reason: 'shadows-code-agent' });
    expect(await Bun.file(ownerPath(served, 'alpha')).exists()).toBe(false);
  });
});

describe('faults', () => {
  it('Conflict for a taken identifier, with the reason, and the file untouched', async () => {
    const served = await serve();
    await seed(served);
    const before = await readFile(ownerPath(served), 'utf8');
    const response = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'researcher',
      definition: DEFINITION,
    });
    expect(response.error?.data?.httpStatus).toBe(409);
    expect(response.error?.data).toMatchObject({ reason: 'agent-file-exists' });
    expect(await readFile(ownerPath(served), 'utf8')).toBe(before);
  });

  it('StaleRevision for a stale expectedHash, carrying the hash on disk, and writes nothing', async () => {
    const served = await serve();
    const hash = await seed(served);
    const edited = agentFileText({ model: OTHER_MODEL }, 'Edited by hand.\n');
    await served.put('researcher.md', edited);
    for (const method of ['update', 'publish', 'withdraw', 'delete'] as const) {
      const response = await callAs(served.owner, `bureau.agents.definitions.${method}`, {
        id: 'researcher',
        expectedHash: hash,
        ...(method === 'update' ? { definition: DEFINITION } : {}),
      });
      expect(response.error?.data?.httpStatus, method).toBe(409);
      expect(response.error?.data?.['expectedRevision'], method).toBe(hash);
      expect(response.error?.data?.['currentRevision'], method).toBe(
        new Bun.CryptoHasher('sha256').update(edited).digest('hex'),
      );
    }
    expect(await readFile(ownerPath(served), 'utf8')).toBe(edited);
    expect(await served.bureau.auditTrail?.query({ runId: 'agent:researcher' })).toEqual([]);
  });

  it('Unprocessable for a definition that would not load, with the problem, and writes nothing', async () => {
    const served = await serve();
    const unknownModel = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'broken',
      definition: { ...DEFINITION, model: 'anthropic/none' },
    });
    expect(unknownModel.error?.data?.httpStatus).toBe(422);
    expect(unknownModel.error?.data).toMatchObject({ reason: 'unknown-model' });
    const unknownTool = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'broken',
      definition: { ...DEFINITION, tools: ['refund'] },
    });
    expect(unknownTool.error?.data).toMatchObject({ reason: 'unknown-tool' });
    expect(served.bureau.agents.list().map((listing) => listing.id)).toEqual(['alpha']);
    expect(await Bun.file(ownerPath(served, 'broken')).exists()).toBe(false);
  });

  it('InvalidParams for an identifier that is not valid, for a key the operation does not declare, and for one the definition does not', async () => {
    const served = await serve();
    const bad = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'Bad_Name',
      definition: DEFINITION,
    });
    expect(bad.error?.data?.httpStatus).toBe(400);
    const extra = await callAs(served.owner, 'bureau.agents.definitions.get', {
      id: 'alpha',
      owner: 'me',
    });
    expect(extra.error?.data?.httpStatus).toBe(400);
    for (const key of ['published', 'owner', 'tool']) {
      const response = await callAs(served.owner, 'bureau.agents.definitions.create', {
        id: 'strict',
        definition: { ...DEFINITION, [key]: true },
      });
      expect([key, response.error?.data?.httpStatus]).toEqual([key, 400]);
    }
    expect(await Bun.file(ownerPath(served, 'strict')).exists()).toBe(false);
  });

  it('NotFound for a write to a file that is gone', async () => {
    const served = await serve();
    for (const method of ['update', 'publish', 'withdraw', 'delete'] as const) {
      const response = await callAs(served.owner, `bureau.agents.definitions.${method}`, {
        id: 'nobody',
        expectedHash: 'abc',
        ...(method === 'update' ? { definition: DEFINITION } : {}),
      });
      expect([method, response.error?.data?.httpStatus]).toEqual([method, 404]);
    }
  });

  it('UnsupportedCapability to write on a Bureau with no agent directory, while it still lists its code agents', async () => {
    const bureau = await createBureau({
      id: 'no-directory',
      agents: {},
      storage: { type: 'memory' },
    });
    try {
      const handler = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });
      const created = await callAs(handler, 'bureau.agents.definitions.create', {
        id: 'writer',
        definition: DEFINITION,
      });
      expect(created.error?.data?.httpStatus).toBe(501);
      const listed = await callAs(handler, 'bureau.agents.definitions.list', {});
      expect(listed.error).toBeUndefined();
      expect(listed.result?.['agents']).toEqual([]);
      const catalog = await callAs(handler, 'bureau.agents.catalog', {});
      expect(catalog.result?.['tools']).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });
});

describe('the audit trail', () => {
  it('records every write that changed a file, attributed to the caller, and a denied write records none', async () => {
    const served = await serve();
    const created = await callAs(served.local, 'bureau.agents.definitions.create', {
      id: 'researcher',
      definition: { ...DEFINITION, name: 'Researcher' },
    });
    const createdHash = created.result?.['hash'] as string;
    const updated = await rpc(
      served.keyed,
      'bureau.agents.definitions.update',
      {
        id: 'researcher',
        expectedHash: createdHash,
        definition: { ...DEFINITION, name: 'Researcher', instructions: 'Second.\n' },
      },
      'operator-key',
    );
    const updatedHash = updated.result?.['hash'] as string;
    const denied = await rpc(
      served.keyed,
      'bureau.agents.definitions.publish',
      { id: 'researcher', expectedHash: updatedHash },
      'alice-key',
    );
    expect(denied.error?.data?.httpStatus).toBe(404);
    const published = await callAs(served.local, 'bureau.agents.definitions.publish', {
      id: 'researcher',
      expectedHash: updatedHash,
    });
    const publishedHash = published.result?.['hash'] as string;
    const withdrawn = await callAs(served.local, 'bureau.agents.definitions.withdraw', {
      id: 'researcher',
      expectedHash: publishedHash,
    });
    const withdrawnHash = withdrawn.result?.['hash'] as string;
    await callAs(served.local, 'bureau.agents.definitions.delete', {
      id: 'researcher',
      expectedHash: withdrawnHash,
    });

    const entries = await served.bureau.auditTrail?.query({ runId: 'agent:researcher' });
    expect(entries?.map((entry) => [entry.type, entry.principal, entry.detail])).toEqual([
      ['agent.created', 'anonymous:local', { id: 'researcher', hash: createdHash }],
      [
        'agent.updated',
        'api-key:operator',
        { id: 'researcher', hash: updatedHash, previousHash: createdHash },
      ],
      [
        'agent.published',
        'anonymous:local',
        { id: 'researcher', hash: publishedHash, previousHash: updatedHash },
      ],
      [
        'agent.withdrawn',
        'anonymous:local',
        { id: 'researcher', hash: withdrawnHash, previousHash: publishedHash },
      ],
      [
        'agent.deleted',
        'anonymous:local',
        { id: 'researcher', hash: withdrawnHash, previousHash: withdrawnHash },
      ],
    ]);
  });

  it('files an entry under an owner the deployment can resolve, so an operator and the owner read it', async () => {
    const served = await serve();
    expect(await served.bureau.getOwner({ kind: 'audit', runId: 'agent:researcher' })).toBe(
      'anonymous:local',
    );
  });

  it('writes none, and does not fail the write, on a Bureau that keeps no audit trail', async () => {
    const served = await serve();
    expect(served.bureau.auditTrail).toBeDefined();
    const source = Object.create(served.bureau, {
      auditTrail: { value: undefined },
    }) as Parameters<typeof createBureauHandler>[0];
    const handler = createBureauHandler(source, { unauthenticatedAccess: 'allow' });
    const created = await callAs(handler, 'bureau.agents.definitions.create', {
      id: 'quiet',
      definition: DEFINITION,
    });
    expect(created.error).toBeUndefined();
  });
});

describe('bureau.agents.catalog', () => {
  /** A model-catalog row that carries what the general audience must never see. */
  function rows(): readonly BackendDescriptor[] {
    const [first, second, third] = createModelCatalog().descriptors;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('Expected the seed catalog to hold rows.');
    }
    return [
      {
        ...first,
        pricing: {
          inputPerMillionTokens: 3,
          outputPerMillionTokens: 15,
          currency: 'USD',
        },
      },
      {
        ...second,
        endpointAmbiguous: true,
        endpoint: 'https://proxy.internal.example.com/v1/messages',
      },
      { ...third, lifecycle: 'retired' },
    ];
  }

  it('returns the models in the catalog unfiltered, projected for the general audience, to a principal holding only bureau.agents:read', async () => {
    const seed = createModelCatalog();
    const service = createModelCatalogService({
      seed,
      descriptorSource: () => Promise.resolve(seed.descriptors),
      now: () => '2026-10-18T00:00:00.000Z',
      newRefreshId: () => 'refresh',
    });
    const installed = rows();
    service.replaceCatalog(installed);
    const served = await serve({ overrides: { modelCatalog: service } });
    // `replaceCatalog` merges by provider, so the set to compare against is what the catalog holds.
    const held = served.bureau.modelCatalog.catalog().descriptors;
    expect(held.some((row) => row.pricing !== undefined)).toBe(true);
    expect(held.some((row) => row.endpointAmbiguous === true)).toBe(true);
    expect(held.some((row) => row.lifecycle === 'retired')).toBe(true);

    const response = await rpc(served.keyed, 'bureau.agents.catalog', {}, 'agents-reader-key');
    expect(response.error).toBeUndefined();
    const models = listOf(response, 'models');
    const pairs = (entries: ReadonlyArray<{ provider: unknown; model: unknown }>) =>
      entries.map((entry) => `${String(entry.provider)}/${String(entry.model)}`).toSorted();
    expect(pairs(models as never)).toEqual(pairs(held));
    expect(models.length).toBe(held.length);
    for (const model of models) {
      expect(Object.hasOwn(model, 'pricing')).toBe(false);
      expect(Object.hasOwn(model, 'endpointAmbiguous')).toBe(false);
    }
    // Every key the general projection keeps reaches the wire, so a field added later is not lost.
    for (const [index, row] of held.entries()) {
      const expected = Object.entries(projectDescriptor(row, 'general'))
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .toSorted();
      expect(Object.keys(models[index] ?? {}).toSorted()).toEqual(expected);
    }
    // The general audience gets an endpoint's operation, never the host that serves it.
    expect(JSON.stringify(response)).not.toContain('proxy.internal.example.com');
    expect(JSON.stringify(response)).not.toContain('pricing');
    expect(JSON.stringify(response)).not.toContain('endpointAmbiguous');
  });

  it('returns the same general projection to the owner and to an operator', async () => {
    const served = await serve();
    const fromOwner = await callAs(served.owner, 'bureau.agents.catalog', {});
    const fromOperator = await rpc(served.keyed, 'bureau.agents.catalog', {}, 'operator-key');
    expect(fromOwner.result).toEqual(fromOperator.result as never);
    expect(listOf(fromOwner, 'models').length).toBe(
      served.bureau.modelCatalog.catalog().descriptors.length,
    );
  });

  it('lists the tools an agent file may name, by name', async () => {
    const served = await serve();
    const response = await callAs(served.owner, 'bureau.agents.catalog', {});
    expect(response.result?.['tools']).toEqual([
      { name: 'lookup-order', description: 'Looks an order up' },
    ]);
  });

  it('describes a credential that holds only bureau.agents:write as unable to read it', async () => {
    const served = await serve();
    const response = await rpc(served.keyed, 'bureau.agents.catalog', {}, 'agents-writer-key');
    expect(response.error?.data?.httpStatus).toBe(403);
  });
});

describe('credentials', () => {
  it('refuses a request with no credentials, and one with a key the deployment does not know', async () => {
    const served = await serve();
    for (const operation of bureauAgentDefinitionsOperations) {
      const anonymous = await served.keyed(
        new Request('http://localhost/jsonrpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: operation.name, params: {} }),
        }),
      );
      expect([operation.name, anonymous.status]).toEqual([operation.name, 401]);
      const unknown = await rpc(served.keyed, operation.name, {}, 'unknown-key');
      expect(unknown.error).toBeDefined();
    }
  });
});
