import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'bun:test';
import type { FetchFunction } from '../../src/ingestion/fetch-from-registry';
import { fetchFromRegistry } from '../../src/ingestion/fetch-from-registry';
import { createMockSkillProvider } from '../../src/test/index';

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill from the registry
---

## Instructions

Do something useful.
`;

function makeSkillMarkdown(name: string, description = `Description for ${name}`): string {
  return `---
name: ${name}
description: ${description}
---

## Instructions for ${name}

Do something useful.
`;
}

interface RecordedRequest {
  url: string;
  authorization: string | null;
}

function createMockFetch(
  responses: Record<string, { status: number; body: string } | 'network-error'>,
  requests: RecordedRequest[] = [],
): FetchFunction {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get('Authorization') });

    const response = responses[url];

    if (response === 'network-error') {
      throw new Error('Network error: connection refused');
    }

    if (response) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.status === 200 ? 'OK' : 'Not Found',
      });
    }

    return new Response('Not Found', { status: 404, statusText: 'Not Found' });
  };
}

/** Generates an Ed25519 key pair as SPKI/PKCS8 PEM strings, for signature tests. */
function generateEd25519KeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

describe('fetchFromRegistry integrity', () => {
  const baseUrl = 'https://registry.example.com/skills';
  it('allows a missing signature when opted out, even with publicKey configured', async () => {
    const provider = createMockSkillProvider();
    const { publicKey } = generateEd25519KeyPair();

    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: VALID_SKILL_MD },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      publicKey,
      allowUnverified: true,
    });

    expect(result.loaded).toEqual(['test-skill']);
    expect(result.errors).toHaveLength(0);
  });
  it('fails closed on a signature-endpoint error, even with allowUnverified set', async () => {
    const provider = createMockSkillProvider();
    const { publicKey } = generateEd25519KeyPair();

    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: VALID_SKILL_MD },
      [`${baseUrl}/test-skill/SKILL.md.sig`]: { status: 500, body: 'Internal Server Error' },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      publicKey,
      // A 500 from the signature endpoint must never be treated as "unsigned" —
      // even the opt-out shouldn't paper over a registry/auth failure.
      allowUnverified: true,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('500');

    const saved = provider.calls.filter((call) => call.method === 'saveSkill');
    expect(saved).toHaveLength(0);
  });
  it('rejects content whose metadata name does not match the requested skill name', async () => {
    const provider = createMockSkillProvider();
    const mismatchedBody = makeSkillMarkdown('a-different-skill');
    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: mismatchedBody },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      allowUnverified: true,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('mismatched');

    const saved = provider.calls.filter((call) => call.method === 'saveSkill');
    expect(saved).toHaveLength(0);
  });
});
