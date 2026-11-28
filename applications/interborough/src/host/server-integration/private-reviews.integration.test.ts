import { buildProduction } from '@lostgradient/velveteen/build';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { curatedShikiPlugin } from '../../../scripts/browser-build.ts';
import { buildTestDocuments } from '../build-info.test-support.ts';
import { startHost, type Host } from '../host.ts';
import { startSignedInRefundFixture } from './signed-in-refund.test-support.ts';

test('the listener serves private Reviews for each current member', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'private-reviews-listener-'));
  const projectDirectory = resolve(import.meta.dirname, '../../..');
  const buildDirectory = join(scratch, 'build');
  let local: Host | undefined;
  let fixture: Awaited<ReturnType<typeof startSignedInRefundFixture>> | undefined;
  try {
    const publication = await buildTestDocuments(buildDirectory);
    await buildProduction({
      projectDirectory,
      routesDirectory: join(projectDirectory, 'src/private-routes'),
      outputDirectory: join(publication, 'private'),
      mode: 'development',
      browserPlugins: [curatedShikiPlugin],
    });
    fixture = await startSignedInRefundFixture({ buildDirectory });
    local = await startHost({
      environment: { INTERBOROUGH_HOME: join(scratch, 'local') },
      buildDirectory,
      plugins: [],
      port: 0,
    });
    const keyRoute = '/settings/api-keys';
    const localKeys = await fetch(new URL(keyRoute, local.url));
    expect(localKeys.status).toBe(200);
    expect(localKeys.headers.get('cache-control')).toBe('private, no-store');
    expect(await localKeys.text()).toContain('settings-api-keys');
    const anonymousKeys = await fixture.send(keyRoute);
    expect(anonymousKeys.status).toBe(401);
    const reviewId = await fixture.requestRefund();
    const anonymous = await fixture.send('/reviews');
    expect(anonymous.status).toBe(401);
    const admin = await fixture.signIn('admin');
    const member = await fixture.signIn('member');
    const memberKeys = await fixture.send(keyRoute, { headers: { cookie: member } });
    expect(memberKeys.status).toBe(200);
    expect(memberKeys.headers.get('cache-control')).toBe('private, no-store');
    expect(await memberKeys.text()).toContain('Sign in as a workspace administrator');
    const adminResponse = await fixture.send('/reviews', { headers: { cookie: admin } });
    const memberResponse = await fixture.send('/reviews', { headers: { cookie: member } });
    expect(adminResponse.status).toBe(200);
    expect(adminResponse.headers.get('cache-control')).toBe('private, no-store');
    expect(await adminResponse.text()).toContain(reviewId);
    expect(memberResponse.status).toBe(200);
    expect(await memberResponse.text()).not.toContain(reviewId);
    fixture.revoke('admin');
    const revoked = await fixture.send('/reviews', { headers: { cookie: admin } });
    expect(revoked.status).toBe(401);
    const missingAsset = await fixture.send('/_assets/missing.js', { headers: { cookie: member } });
    expect(missingAsset.status).toBe(404);
    const restrictedApi = await fixture.send('/api/missing', { headers: { cookie: member } });
    expect(restrictedApi.status).toBe(403);
    const unknown = await fixture.send('/unknown', { headers: { accept: 'text/html' } });
    expect(unknown.status).toBe(404);
    const publicPage = await fixture.send('/');
    expect(publicPage.status).toBe(200);
    expect(await publicPage.text()).toContain('Native test document');
  } finally {
    await local?.close();
    await fixture?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
