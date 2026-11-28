import { buildProduction } from '@lostgradient/velveteen/build';
import { createApplication } from '@lostgradient/velveteen/server';
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { curatedShikiPlugin } from '../../scripts/browser-build.ts';

const scratch = await mkdtemp(join(tmpdir(), 'private-reviews-render-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

test('renders the real Reviews shell on the server using request-local data', async () => {
  const projectDirectory = resolve(import.meta.dirname, '../..');
  const generation = await buildProduction({
    projectDirectory,
    routesDirectory: join(projectDirectory, 'src/private-routes'),
    outputDirectory: join(scratch, 'generation'),
    mode: 'development',
    browserPlugins: [curatedShikiPlugin],
  });
  const calls: string[] = [];
  const application = await createApplication({
    generation,
    hooks: {
      handleFetch: ({ event, request }) => {
        const path = new URL(request.url).pathname;
        calls.push(path);
        const actor = event.request.headers.get('x-test-actor') ?? 'alice';
        return path === '/api/v1/principal'
          ? Response.json({
              method: 'browser-session',
              subject: actor,
              scopes: ['reviews:read'],
              workspace: { workspaceId: 'one', actorId: actor, membershipRevision: '1' },
            })
          : Response.json({
              jsonrpc: '2.0',
              id: 'bureau.reviews.list',
              result: { reviews: [], nextPageToken: null, total: 0 },
            });
      },
    },
  });
  try {
    const response = await application.fetch(new Request('https://example.test/reviews'));
    expect(response.status).toBe(200);
    const alice = await response.text();
    expect(alice).toContain('Reviews');
    expect(alice).toContain('alice');
    expect(calls).toEqual(['/api/v1/principal', '/jsonrpc', '/jsonrpc']);
    const other = await application.fetch(
      new Request('https://example.test/reviews', {
        headers: { 'x-test-actor': 'bob' },
      }),
    );
    const bob = await other.text();
    expect(other.status).toBe(200);
    expect(bob).toContain('bob');
    expect(bob).not.toContain('alice');
  } finally {
    await application.dispose();
  }
});
