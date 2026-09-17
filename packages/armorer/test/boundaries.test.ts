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
  it('keeps MCP out of dependencies unless this source package directly owns MCP execution', () => {
    expect(pkg.dependencies?.['@modelcontextprotocol/sdk']).toBeDefined();
    expect(pkg.peerDependencies?.['@modelcontextprotocol/sdk']).toBeUndefined();
    expect(pkg.peerDependenciesMeta?.['@modelcontextprotocol/sdk']).toBeUndefined();
  });
});
