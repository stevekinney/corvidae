import { describe, expect, test } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GitHubAppError,
  mintAppJwt,
  mintInstallationToken,
  readAppPrivateKey,
  type FetchImplementation,
} from './github-app.ts';

/**
 * The App credential path, exercised against a key pair generated here.
 *
 * Nothing in this file reads the real private key or reaches GitHub: the signature is verified
 * with the public half of a throwaway pair, and the token exchange runs against a `fetch` that
 * answers from memory.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('mintAppJwt', () => {
  const now = new Date('2026-09-19T12:00:00Z');
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;

  test('signs an RS256 assertion the public key verifies', () => {
    const jwt = mintAppJwt({ privateKey, appId: 4_997_180, now });
    const [header = '', payload = '', signature = ''] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  test('backdates the issue time and stays inside the ten minutes GitHub allows', () => {
    const jwt = mintAppJwt({ privateKey, appId: 4_997_180, now });
    const payload = decodeSegment(jwt.split('.').at(1) ?? '');
    expect(payload['iss']).toBe(4_997_180);
    expect(payload['iat']).toBe(issuedAt);
    expect(Number(payload['exp']) - Number(payload['iat'])).toBeLessThanOrEqual(600);
    expect(Number(payload['exp'])).toBeGreaterThan(Math.floor(now.getTime() / 1000));
  });
});

describe('mintInstallationToken', () => {
  function fakeFetch(
    status: number,
    body: unknown,
  ): { fetchImplementation: FetchImplementation; seen: { url: string; authorization: string }[] } {
    const seen: { url: string; authorization: string }[] = [];
    const fetchImplementation: FetchImplementation = async (url, init) => {
      seen.push({ url, authorization: init?.headers?.['authorization'] ?? '' });
      return { status, text: async () => JSON.stringify(body) };
    };
    return { fetchImplementation, seen };
  }

  test('exchanges an App JWT for an installation token', async () => {
    const { fetchImplementation, seen } = fakeFetch(201, {
      token: 'ghs_installation',
      expires_at: '2026-09-19T13:00:00Z',
      repository_selection: 'selected',
    });
    const minted = await mintInstallationToken({
      privateKey,
      appId: 4_997_180,
      installationId: 162_905_409,
      fetchImplementation,
    });
    expect(minted.token).toBe('ghs_installation');
    expect(minted.repositorySelection).toBe('selected');
    expect(seen.at(0)?.url).toBe(
      'https://api.github.com/app/installations/162905409/access_tokens',
    );
    expect(seen.at(0)?.authorization.startsWith('Bearer ')).toBe(true);
  });

  test('reports the status and GitHub’s own body when the exchange fails', async () => {
    const { fetchImplementation } = fakeFetch(403, { message: 'Bad credentials' });
    await expect(
      mintInstallationToken({
        privateKey,
        appId: 4_997_180,
        installationId: 162_905_409,
        fetchImplementation,
      }),
    ).rejects.toThrow(/HTTP 403.*Bad credentials/s);
  });
});

describe('readAppPrivateKey', () => {
  test('prefers the inline PEM a workflow secret supplies', async () => {
    await expect(readAppPrivateKey({ MIRROR_APP_PRIVATE_KEY: privateKey })).resolves.toBe(
      privateKey,
    );
  });

  test('reads the PEM from the file a local run names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mirror-app-key-'));
    try {
      const path = join(directory, 'key.pem');
      await Bun.write(path, privateKey);
      await expect(readAppPrivateKey({ MIRROR_APP_PRIVATE_KEY_FILE: path })).resolves.toBe(
        privateKey,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('refuses when neither is set, and when the named file is absent', async () => {
    await expect(readAppPrivateKey({})).rejects.toThrow(GitHubAppError);
    await expect(
      readAppPrivateKey({ MIRROR_APP_PRIVATE_KEY_FILE: '/nowhere/mirror-key.pem' }),
    ).rejects.toThrow(/does not exist/);
  });
});
