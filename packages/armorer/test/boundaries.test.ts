import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!packageJson || typeof packageJson !== 'object') {
  throw new Error('Expected package.json to parse to an object');
}
const pkg: {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
} = packageJson;

describe('package dependency boundaries', () => {
  it('owns the MCP v2 packages used for execution', () => {
    expect(pkg.dependencies?.['@modelcontextprotocol/client']).toBeDefined();
    expect(pkg.dependencies?.['@modelcontextprotocol/core']).toBeDefined();
    expect(pkg.dependencies?.['@modelcontextprotocol/server']).toBeDefined();
    expect(pkg.dependencies?.['@modelcontextprotocol/sdk']).toBeUndefined();
  });
});
