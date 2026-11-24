import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { OAuthStore } from './oauth-store.ts';

const verifier = 'a'.repeat(43);
const consent = {
  issuer: 'https://issuer.test',
  tenant: 'tenant',
  resource: 'https://resource.test',
  scopes: ['read'],
  state: '',
  client: 'client',
  redirect: 'https://client.test/callback',
  csrf: 'csrf',
  binding: 'binding',
  subject: 'subject',
  challenge: createHash('sha256').update(verifier).digest('base64url'),
  expiresAt: 4_102_444_800_000,
};
const binding = {
  issuer: 'https://issuer.test',
  client: 'client',
  csrf: 'csrf',
  binding: 'binding',
  subject: 'subject',
};

describe('OAuthStore consent', () => {
  test('approval and denial have one winner without partial grant or code records', async () => {
    using storage = new MemoryStorage();
    const first = new OAuthStore(storage);
    const second = new OAuthStore(storage);
    await first.createConsent('consent', consent);
    const approval = {
      grantId: 'grant',
      code: 'code',
      tenant: 'tenant',
      subject: 'subject',
      resource: 'https://resource.test',
      scopes: ['read'],
    };
    const results = await Promise.all([
      first.approveConsent('consent', binding, approval),
      second.denyConsent('consent', binding),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await first.getGrant('grant')).toEqual(
      results[0] ? expect.objectContaining({ subject: 'subject' }) : null,
    );
    expect(await first.getCode('code')).toEqual(
      results[0] ? expect.objectContaining({ grantId: 'grant' }) : null,
    );
  });

  test('a wrong binding does not consume the consent', async () => {
    using storage = new MemoryStorage();
    const store = new OAuthStore(storage);
    await store.createConsent('consent', consent);
    expect(await store.denyConsent('consent', { ...binding, csrf: 'wrong' })).toBe(false);
    expect(await store.denyConsent('consent', binding)).toBe(true);
  });

  test('another issuer cannot consume consent or exchange its code', async () => {
    using storage = new MemoryStorage();
    const store = new OAuthStore(storage);
    await store.createConsent('consent', consent);
    expect(await store.denyConsent('consent', { ...binding, issuer: 'https://other.test' })).toBe(
      false,
    );
    expect(
      await store.approveConsent('consent', binding, {
        grantId: 'grant',
        code: 'code',
        tenant: 'tenant',
        subject: 'subject',
        resource: 'https://resource.test',
        scopes: ['read'],
      }),
    ).toBe(true);
    const exchange = {
      issuer: 'https://issuer.test',
      code: 'code',
      client: 'client',
      redirect: consent.redirect,
      resource: 'https://resource.test',
      verifier,
      access: 'access',
      refresh: 'refresh',
      accessExpiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 60_000,
    };
    expect(await store.exchange({ ...exchange, issuer: 'https://other.test' })).toBe(false);
    expect(await store.exchange(exchange)).toBe(true);
    const rotation = {
      issuer: 'https://other.test',
      refresh: 'refresh',
      client: 'client',
      resource: 'https://resource.test',
      access: 'next-access',
      nextRefresh: 'next-refresh',
      accessExpiresAt: exchange.accessExpiresAt,
      refreshExpiresAt: exchange.refreshExpiresAt,
      scopes: ['read'],
    };
    expect(await store.rotate(rotation)).toBe('invalid');
    await store.revokeToken('refresh', 'https://other.test', 'client');
    expect(await store.getAccess('access')).not.toBeNull();
  });

  test('a collision leaves consent available and creates no grant', async () => {
    using storage = new MemoryStorage();
    const store = new OAuthStore(storage);
    const approval = {
      grantId: 'grant',
      code: 'code',
      tenant: 'tenant',
      subject: 'subject',
      resource: 'https://resource.test',
      scopes: ['read'],
    };
    await store.createConsent('first', consent);
    expect(await store.approveConsent('first', binding, approval)).toBe(true);
    await store.createConsent('second', consent);
    expect(await store.approveConsent('second', binding, { ...approval, grantId: 'other' })).toBe(
      false,
    );
    expect(await store.getGrant('other')).toBeNull();
    expect(await store.denyConsent('second', binding)).toBe(true);
  });

  test('exchange consumes a code once and preserves authority', async () => {
    using storage = new MemoryStorage();
    const first = new OAuthStore(storage);
    const second = new OAuthStore(storage);
    await first.createConsent('consent', consent);
    await first.approveConsent('consent', binding, {
      grantId: 'grant',
      code: 'code',
      tenant: 'tenant',
      subject: 'subject',
      resource: 'https://resource.test',
      scopes: ['read'],
    });
    const input = {
      code: 'code',
      issuer: 'https://issuer.test',
      client: 'client',
      redirect: 'https://client.test/callback',
      resource: 'https://resource.test',
      verifier,
      access: 'access',
      refresh: 'refresh',
      accessExpiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 60_000,
    };
    expect(await first.exchange({ ...input, verifier: 'b'.repeat(43) })).toBe(false);
    const results = await Promise.all([
      first.exchange(input),
      second.exchange({ ...input, access: 'other-access', refresh: 'other-refresh' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? 'access' : 'other-access';
    expect(await second.getAccess(winner)).toEqual(
      expect.objectContaining({
        tenant: 'tenant',
        subject: 'subject',
        issuer: 'https://issuer.test',
        client: 'client',
        resource: 'https://resource.test',
        scopes: ['read'],
      }),
    );
    expect(await first.exchange(input)).toBe(false);
  });

  test('authenticated refresh replay revokes the grant, but a wrong binding cannot', async () => {
    using storage = new MemoryStorage();
    const store = new OAuthStore(storage);
    await store.createConsent('consent', consent);
    await store.approveConsent('consent', binding, {
      grantId: 'grant',
      code: 'code',
      tenant: 'tenant',
      subject: 'subject',
      resource: 'https://resource.test',
      scopes: ['read'],
    });
    const expiresAt = Date.now() + 60_000;
    await store.exchange({
      code: 'code',
      issuer: 'https://issuer.test',
      client: 'client',
      redirect: 'https://client.test/callback',
      resource: 'https://resource.test',
      verifier,
      access: 'access',
      refresh: 'refresh',
      accessExpiresAt: expiresAt,
      refreshExpiresAt: expiresAt,
    });
    const rotation = {
      refresh: 'refresh',
      issuer: 'https://issuer.test',
      client: 'client',
      resource: 'https://resource.test',
      access: 'new-access',
      nextRefresh: 'new-refresh',
      accessExpiresAt: expiresAt,
      refreshExpiresAt: expiresAt,
      scopes: ['read'],
    };
    expect(await store.rotate(rotation)).toBe('rotated');
    expect(await store.getAccess('access')).toBeNull();
    expect(await store.rotate({ ...rotation, client: 'other' })).toBe('invalid');
    expect(await store.rotate({ ...rotation, resource: 'https://other.test' })).toBe('invalid');
    expect(await store.getAccess('new-access')).not.toBeNull();
    expect(await store.rotate(rotation)).toBe('replay_revoked');
    expect(await store.getAccess('new-access')).toBeNull();
  });

  test('a retained spent refresh token revokes its family after its own expiry', async () => {
    using storage = new MemoryStorage();
    const time = spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const store = new OAuthStore(storage);
      await store.createConsent('consent', consent);
      await store.approveConsent('consent', binding, {
        grantId: 'grant',
        code: 'code',
        tenant: 'tenant',
        subject: 'subject',
        resource: 'https://resource.test',
        scopes: ['read'],
      });
      await store.exchange({
        code: 'code',
        issuer: 'https://issuer.test',
        client: 'client',
        redirect: consent.redirect,
        resource: 'https://resource.test',
        verifier,
        access: 'access',
        refresh: 'refresh',
        accessExpiresAt: 2_000,
        refreshExpiresAt: 2_000,
      });
      const rotation = {
        refresh: 'refresh',
        issuer: 'https://issuer.test',
        client: 'client',
        resource: 'https://resource.test',
        access: 'replacement',
        nextRefresh: 'next',
        accessExpiresAt: 4_000,
        refreshExpiresAt: 4_000,
        scopes: ['read'],
      };
      expect(await store.rotate(rotation)).toBe('rotated');
      time.mockReturnValue(3_000);
      expect(await store.rotate(rotation)).toBe('replay_revoked');
      expect(await store.getAccess('replacement')).toBeNull();
    } finally {
      time.mockRestore();
    }
  });

  test('refresh survives access expiry and rejects an expired unspent refresh', async () => {
    using storage = new MemoryStorage();
    const time = spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const store = new OAuthStore(storage);
      for (const name of ['valid', 'expired']) {
        await store.createConsent(name, consent);
        expect(
          await store.approveConsent(name, binding, {
            grantId: name,
            code: `code-${name}`,
            tenant: 'tenant',
            subject: 'subject',
            resource: 'https://resource.test',
            scopes: ['read'],
          }),
        ).toBe(true);
        expect(
          await store.exchange({
            issuer: 'https://issuer.test',
            code: `code-${name}`,
            client: 'client',
            redirect: consent.redirect,
            resource: 'https://resource.test',
            verifier,
            access: `access-${name}`,
            refresh: `refresh-${name}`,
            accessExpiresAt: 2_000,
            refreshExpiresAt: name === 'valid' ? 4_000 : 2_000,
          }),
        ).toBe(true);
      }
      time.mockReturnValue(3_000);
      expect(await store.getAccess('access-valid')).toBeNull();
      const rotation = {
        issuer: 'https://issuer.test',
        client: 'client',
        resource: 'https://resource.test',
        access: 'new-access',
        nextRefresh: 'new-refresh',
        accessExpiresAt: 4_000,
        refreshExpiresAt: 6_000,
        scopes: ['read'],
      };
      expect(await store.rotate({ ...rotation, refresh: 'refresh-valid' })).toBe('rotated');
      expect(await store.getAccess('new-access')).not.toBeNull();
      expect(
        await store.rotate({
          ...rotation,
          access: 'expired-access',
          nextRefresh: 'expired-next',
          refresh: 'refresh-expired',
        }),
      ).toBe('invalid');
    } finally {
      time.mockRestore();
    }
  });

  test('revocation fences issuance and does not revoke an independent grant', async () => {
    using storage = new MemoryStorage();
    const store = new OAuthStore(storage);
    const expiresAt = Date.now() + 60_000;
    for (const name of ['one', 'two']) {
      await store.createConsent(name, consent);
      await store.approveConsent(name, binding, {
        grantId: name,
        code: `code-${name}`,
        tenant: 'tenant',
        subject: 'subject',
        resource: 'https://resource.test',
        scopes: ['read'],
      });
    }
    await store.revokeGrant('one');
    const issue = (name: string) =>
      store.exchange({
        code: `code-${name}`,
        issuer: 'https://issuer.test',
        client: 'client',
        redirect: 'https://client.test/callback',
        resource: 'https://resource.test',
        verifier,
        access: `access-${name}`,
        refresh: `refresh-${name}`,
        accessExpiresAt: expiresAt,
        refreshExpiresAt: expiresAt,
      });
    expect(await issue('one')).toBe(false);
    expect(await issue('two')).toBe(true);
    expect(await store.getAccess('access-two')).not.toBeNull();
  });

  test('revoke racing exchange leaves no usable credential', async () => {
    using storage = new MemoryStorage();
    const first = new OAuthStore(storage);
    const second = new OAuthStore(storage);
    await first.createConsent('race', consent);
    await first.approveConsent('race', binding, {
      grantId: 'grant',
      code: 'code',
      tenant: 'tenant',
      subject: 'subject',
      resource: 'https://resource.test',
      scopes: ['read'],
    });
    await Promise.all([
      first.exchange({
        code: 'code',
        issuer: 'https://issuer.test',
        client: 'client',
        redirect: consent.redirect,
        resource: 'https://resource.test',
        verifier,
        access: 'access',
        refresh: 'refresh',
        accessExpiresAt: Date.now() + 60_000,
        refreshExpiresAt: Date.now() + 60_000,
      }),
      second.revokeGrant('grant'),
    ]);
    expect(await first.getAccess('access')).toBeNull();
    expect(
      await first.rotate({
        refresh: 'refresh',
        issuer: 'https://issuer.test',
        client: 'client',
        resource: 'https://resource.test',
        access: 'later',
        nextRefresh: 'later-refresh',
        accessExpiresAt: Date.now() + 60_000,
        refreshExpiresAt: Date.now() + 60_000,
        scopes: ['read'],
      }),
    ).toBe('invalid');
  });
});
