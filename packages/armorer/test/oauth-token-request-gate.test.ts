import type { FetchLike } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'bun:test';
import { expectPromiseToReject } from '../src/async-assertion-test-helpers';
import {
  withOAuthTokenRequestGate,
  type McpOAuthTokenRequestOutcome,
} from '../src/integrations/mcp/oauth-token-request-gate';

describe('OAuth token request admission', () => {
  for (const grantType of ['authorization_code', 'refresh_token'] as const) {
    it(`waits for ${grantType} admission and snapshots the finalized request`, async () => {
      const admitted = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const credentialKey = grantType === 'authorization_code' ? 'code' : 'refresh_token';
      const body = new URLSearchParams({ grant_type: grantType, [credentialKey]: 'private-value' });
      const headers = new Headers({ Authorization: 'Basic client', DPoP: 'proof' });
      const endpoint = new URL('https://issuer.example/token');
      const outcomes: McpOAuthTokenRequestOutcome[] = [];
      let calls = 0;
      const response = Response.json({ access_token: 'new-token' });
      const underlying: FetchLike = async (url, init) => {
        calls += 1;
        expect(String(url)).toBe('https://issuer.example/token');
        if (!(init?.body instanceof URLSearchParams)) throw new Error('Expected finalized form');
        expect(init.body.toString()).toBe(
          new URLSearchParams({
            grant_type: grantType,
            [credentialKey]: 'private-value',
          }).toString(),
        );
        expect(new Headers(init?.headers).get('Authorization')).toBe('Basic client');
        return response;
      };
      const guarded = withOAuthTokenRequestGate(underlying, async (request) => {
        expect(Object.isFrozen(request)).toBe(true);
        expect(request).toEqual({
          grantType,
          tokenEndpoint: endpoint.href,
          credential: 'private-value',
        });
        entered.resolve();
        await admitted.promise;
        return {
          settle(outcome) {
            outcomes.push(outcome);
          },
        };
      });
      const pending = guarded(endpoint, { method: 'POST', body, headers });
      await entered.promise;
      body.set(credentialKey, 'changed');
      headers.set('Authorization', 'changed');
      endpoint.pathname = '/changed';
      expect(calls).toBe(0);
      admitted.resolve();
      expect(await pending).toBe(response);
      expect(calls).toBe(1);
      expect(outcomes).toEqual(['response']);
    });
  }

  it('rejects missing and duplicate fields before admission or dispatch', async () => {
    let calls = 0;
    let admissions = 0;
    const guarded = withOAuthTokenRequestGate(
      async () => {
        calls += 1;
        return new Response();
      },
      () => {
        admissions += 1;
      },
    );
    for (const form of [
      'grant_type=authorization_code',
      'grant_type=refresh_token&refresh_token=',
      'grant_type=authorization_code&code=a&code=b',
      'grant_type=refresh_token&refresh_token=a&refresh_token=b',
      'grant_type=authorization_code&grant_type=refresh_token&code=a',
      'grant_type=other&grant_type=refresh_token&refresh_token=a',
    ]) {
      await expectPromiseToReject(
        guarded('https://issuer.example/token', {
          method: 'POST',
          body: new URLSearchParams(form),
        }),
        (error) => expect(error).toBeInstanceOf(Error),
      );
    }
    expect(calls).toBe(0);
    expect(admissions).toBe(0);
  });

  it('sanitizes admission and settlement failures without leaking their causes', async () => {
    let calls = 0;
    const underlying: FetchLike = async () => {
      calls += 1;
      return new Response();
    };
    for (const phase of ['admit', 'settle']) {
      const guarded = withOAuthTokenRequestGate(underlying, () => {
        if (phase === 'admit') throw new Error('private-credential');
        return {
          settle() {
            throw new Error('private-credential');
          },
        };
      });
      await expectPromiseToReject(
        guarded('https://issuer.example/token', {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: 'private-credential',
          }),
        }),
        (error) => {
          expect(String(error)).not.toContain('private-credential');
          expect(error).not.toHaveProperty('cause');
        },
      );
    }
    expect(calls).toBe(1);
  });

  it('admits exactly one concurrent request using a shared conditional claim', async () => {
    let claimed = false;
    let calls = 0;
    const guard = () => {
      if (claimed) throw new Error('already claimed');
      claimed = true;
    };
    const underlying: FetchLike = async () => {
      calls += 1;
      return new Response();
    };
    const clients = [
      withOAuthTokenRequestGate(underlying, guard),
      withOAuthTokenRequestGate(underlying, guard),
    ];
    const results = await Promise.allSettled(
      clients.map((client) =>
        client('https://issuer.example/token', {
          method: 'POST',
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'one-use' }),
        }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(calls).toBe(1);
  });

  it('settles definite nonce challenges and unknown network outcomes without replay', async () => {
    const outcomes: McpOAuthTokenRequestOutcome[] = [];
    let admissions = 0;
    let calls = 0;
    const guarded = withOAuthTokenRequestGate(
      async () => {
        calls += 1;
        if (calls === 4) throw new Error('network lost');
        return Response.json({ error: 'use_dpop_nonce' }, { status: 400 });
      },
      () => {
        admissions += 1;
        return {
          settle(outcome) {
            outcomes.push(outcome);
          },
        };
      },
    );
    const init = {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'one-use' }),
    };
    await guarded('https://issuer.example/token', init);
    await guarded('https://issuer.example/token', { ...init, headers: { DPoP: 'proof' } });
    await guarded('https://issuer.example/token', { ...init, headers: { DPoP: 'new-proof' } });
    await expectPromiseToReject(guarded('https://issuer.example/token', init), (error) =>
      expect(error).toBeInstanceOf(Error),
    );
    expect(outcomes).toEqual(['response', 'nonce-challenge', 'nonce-challenge', 'unknown']);
    expect(admissions).toBe(4);
    expect(calls).toBe(4);
  });

  it('passes non-token requests through untouched', async () => {
    let calls = 0;
    const init = {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    };
    const guarded = withOAuthTokenRequestGate(
      async (_url, options) => {
        expect(options).toBe(init);
        calls += 1;
        return new Response();
      },
      () => {
        throw new Error('must not admit');
      },
    );
    await guarded('https://issuer.example/token', init);
    expect(calls).toBe(1);
  });
});
