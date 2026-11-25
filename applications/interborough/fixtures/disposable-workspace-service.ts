import { principalFromApiKey } from '@lostgradient/backchannel';
import { BUREAU_SCOPES, type WorkspaceMembership } from '@lostgradient/bureau';
import { AUTHORIZATION_SCOPES } from '@lostgradient/weft';
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createHostAuthority } from '../src/host/host-authority.ts';
import { resetOwnedFixture } from './fixture-ownership.ts';

/** A test-only service. Its root must be a newly created disposable directory. */
export async function createDisposableWorkspaceService(root: string, beforePublish?: () => void) {
  const rootEntry = await lstat(root);
  const rootEntries = await readdir(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() || rootEntries.length !== 0)
    throw new Error('Fixture root must be an empty directory');
  root = await realpath(root);
  const workspaceId = crypto.randomUUID();
  const credentials = new Map<string, WorkspaceMembership>();
  const namespaces = new Map<
    string,
    { actor: string; disposable: boolean; mutate: boolean; created: boolean }
  >();
  const authority = await createHostAuthority(
    {
      workspaceId,
      resolveMembership: async ({ subject }) =>
        [...credentials.values()].find((member) => member.actorId === subject) ?? null,
      resolveOwnerMembership: async (owner) =>
        [...credentials.values()].find((member) => member.owner === owner) ?? null,
    },
    {
      resolveApiKeyPrincipal: async (key) => {
        const member = credentials.get(key);
        return member === undefined
          ? null
          : principalFromApiKey({
              subject: member.actorId,
              scopes: [...AUTHORIZATION_SCOPES, ...BUREAU_SCOPES],
            });
      },
    },
  );
  let previous = Promise.resolve();
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = previous.then(operation);
    previous = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function provision(name: string, disposable: boolean, initial?: string, mutate = true) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || namespaces.has(name))
      throw new Error('Invalid namespace');
    const key = crypto.randomUUID();
    const actor = crypto.randomUUID();
    const membership: WorkspaceMembership = {
      version: 1,
      workspaceId,
      actorId: actor,
      actorKind: 'service',
      owner: `fixture:${actor}`,
      membershipRevision: 'fixture-policy-v1',
      capabilities: ['workspace:use'],
    };
    if (initial !== undefined) {
      const home = join(root, name);
      const lease = await resetOwnedFixture(home, { root, owner: root });
      try {
        await writeFile(join(home, 'state.json'), JSON.stringify({ state: initial, revision: 1 }));
      } finally {
        lease.release();
      }
    }
    namespaces.set(name, { actor, disposable, mutate, created: initial !== undefined });
    credentials.set(key, membership);
    return { key, actor, policyVersion: membership.membershipRevision };
  }
  async function handle(request: Request): Promise<Response> {
    const body = request.method === 'POST' || request.method === 'PUT' ? await request.text() : '';
    return exclusive(async () => {
      const context = await authority.authenticate(request);
      if (context instanceof Response) return context;
      const actor = context.principal?.workspace?.actorId;
      const own = [...namespaces].find(([, entry]) => entry.actor === actor);
      if (own === undefined) return new Response('Forbidden', { status: 403 });
      const target = new URL(request.url).searchParams.get('target') ?? own[0];
      const entry = namespaces.get(target);
      if (target !== own[0] || entry === undefined)
        return new Response('Forbidden', { status: 403 });
      if (request.method !== 'GET') {
        const denied = await authority.authorize(request, 'private-owned');
        if (denied !== undefined || !entry.mutate || !entry.disposable)
          return new Response('Forbidden', { status: 403 });
      }
      const home = join(root, target);
      const revisionPath = join(home, 'state.json');
      const original = entry.created ? await readFile(revisionPath, 'utf8') : undefined;
      const { state, revision } =
        original === undefined
          ? { state: '', revision: 0 }
          : (JSON.parse(original) as { state: string; revision: number });
      if (request.method === 'GET') {
        if (!entry.created) return new Response('Not found', { status: 404 });
        return Response.json({ state, revision });
      }
      let lease: Awaited<ReturnType<typeof resetOwnedFixture>> | undefined;
      if (request.method === 'PUT' && revision > 0) {
        // The state and revision are published together below.
      } else if (
        (request.method === 'POST' && revision === 0) ||
        (request.method === 'DELETE' && revision > 0)
      ) {
        lease = await resetOwnedFixture(home, { root, owner: root });
        try {
          const remaining = await readdir(home);
          if (remaining.includes('state.json')) throw new Error('Reset left fixture state');
        } catch (error) {
          lease.release();
          throw error;
        }
      } else return new Response('Method not allowed', { status: 405 });
      const temporary = `${revisionPath}.${crypto.randomUUID()}`;
      let published = false;
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            state: request.method === 'DELETE' ? '' : body,
            revision: revision + 1,
          }),
          { flag: 'wx' },
        );
        beforePublish?.();
        await rename(temporary, revisionPath);
        published = true;
        entry.created = true;
      } finally {
        try {
          if (!published) {
            await rm(temporary, { force: true });
            if (lease !== undefined && original !== undefined)
              await writeFile(revisionPath, original);
          }
        } finally {
          lease?.release();
        }
      }
      return Response.json({ revision: revision + 1 });
    });
  }
  function issueAdditional(key: string) {
    const member = credentials.get(key);
    if (member === undefined) throw new Error('Unknown fixture credential');
    const additional = crypto.randomUUID();
    credentials.set(additional, member);
    return additional;
  }
  return {
    provision,
    handle,
    issueAdditional,
    revoke: (key: string) => exclusive(async () => credentials.delete(key)),
  };
}
