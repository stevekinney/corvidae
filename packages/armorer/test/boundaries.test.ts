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

describe('armorer/protocol subpath', () => {
  // Conversationalist, and through it the browser Chat component, imports this subpath without
  // the rest of Armorer. Anything it imports beyond its own directory and the lifecycle utilities
  // would drag Armorer's MCP, OpenAI Agents, and OpenTelemetry dependencies into that bundle.
  it('imports nothing outside its own directory except @lostgradient/lifecycle', async () => {
    const directory = new URL('../src/protocol/', import.meta.url).pathname;
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const offending: string[] = [];
    for await (const file of new Bun.Glob('*.ts').scan(directory)) {
      if (file.endsWith('.test.ts')) continue;
      const source = await Bun.file(`${directory}${file}`).text();
      for (const { path } of transpiler.scanImports(source)) {
        const local = path.startsWith('./') && !path.slice(2).includes('/');
        if (!local && path !== '@lostgradient/lifecycle') offending.push(`${file} -> ${path}`);
      }
    }
    expect(offending).toEqual([]);
  });
});
