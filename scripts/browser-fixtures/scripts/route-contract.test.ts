import type { ComponentEntry } from '@lostgradient/testing';
import { describe, expect, it } from 'bun:test';

import { resolveFixtureRequest } from '../src/route-contract.ts';

const entries: ComponentEntry[] = [
  {
    name: 'Button',
    slug: 'button',
    route: '/page/button',
    fixtures: [
      {
        name: 'primary',
        mode: 'direct',
        fixtureContentHash: 'a'.repeat(64),
        category: 'visual-contract',
      },
    ],
  },
];

describe('fixture route contract', () => {
  it('resolves a default fixture without query parameters', () => {
    const result = resolveFixtureRequest(entries, 'button', null, null);
    expect('entry' in result && result.fixture.name).toBe('primary');
  });

  it('rejects unknown components and fixtures', () => {
    expect(resolveFixtureRequest(entries, 'missing', null, null)).toEqual({
      status: 404,
      message: "Unknown fixture component 'missing'.",
    });
    expect(resolveFixtureRequest(entries, 'button', 'missing', 'a'.repeat(64))).toEqual({
      status: 404,
      message: "Unknown fixture 'button/missing'.",
    });
  });

  it('requires and validates hashes for named fixtures', () => {
    expect(resolveFixtureRequest(entries, 'button', 'primary', null)).toEqual({
      status: 400,
      message: "Fixture 'button/primary' requires fixtureContentHash.",
    });
    const result = resolveFixtureRequest(entries, 'button', 'primary', 'b'.repeat(64));
    expect('status' in result && result.status).toBe(409);
    expect('status' in result && result.message).toContain('hash drift');
  });
});
