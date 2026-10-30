import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import * as root from '../src';
import * as coding from '../src/coding';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!packageJson || typeof packageJson !== 'object') {
  throw new Error('Expected package.json to parse to an object');
}
const pkg: {
  exports?: Record<string, unknown>;
} = packageJson;
const rootSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const openAIAgentsAdapterSource = readFileSync(
  new URL('../src/adapters/open-ai/agents/index.ts', import.meta.url),
  'utf8',
);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('public API contract', () => {
  it('supports definition, identity, and registry operations from the root', () => {
    const definition = root.defineTool({
      name: 'public-tool',
      description: 'A root-imported tool definition',
      namespace: 'public',
      version: '1.0.0',
    });
    const registry = root.createRegistry();
    registry.register(definition);

    expect(root.parseToolId(definition.id)).toEqual({
      namespace: 'public',
      name: 'public-tool',
      version: '1.0.0',
    });
    expect(registry.resolve({ namespace: 'public', name: 'public-tool' })).toEqual(definition);
    expect(root.serializeToolDefinition(definition).name).toBe('public-tool');
  });

  it('preserves distinct registry and fuzzy name candidates', () => {
    expect(root.buildNameCandidates('my.tool')).toEqual(['my-tool', 'tool']);
    expect(root.buildRegistryNameCandidates('my.tool')).toEqual([
      'my-tool',
      'y-tool',
      '-tool',
      'tool',
      'ool',
      'ol',
      'l',
    ]);
    expect(root.resolveFuzzyToolName('missing', [])).toEqual({ resolved: null });
    expect(root.resolveName('missing', root.createRegistry())).toEqual({
      resolved: null,
      tier: 'exact',
    });
  });

  it('supports JSON and schema inspection from the root', () => {
    const input = { z: [3, 2], a: { b: true } };
    root.assertJsonValue(input);
    expect(root.stableStringifyJson(input)).toBe('{"a":{"b":true},"z":[3,2]}');
    expect(() => root.assertJsonValue({ value: undefined })).toThrow('Undefined');
    expect(root.normalizeTextQuery('  PUBLIC Tool  ')?.query).toBe('public tool');
  });

  it('exports the root and the subpaths that keep optional dependencies out of it, nothing else', () => {
    expect(pkg.exports).toEqual({
      '.': './src/index.ts',
      './protocol': './src/protocol/index.ts',
      './open-ai/agents': './src/adapters/open-ai/agents/index.ts',
      './coding': './src/coding/index.ts',
      './tool-sources': './src/integrations/tool-sources/index.ts',
    });
  });

  it('bundles the root entry for the browser without Node builtins', async () => {
    const build = await Bun.build({
      entrypoints: [new URL('../src/index.ts', import.meta.url).pathname],
      define: { 'import.meta.env': '{}' },
      format: 'esm',
      target: 'browser',
    });
    expect(build.logs.map(String)).toEqual([]);
    expect(build.success).toBe(true);
    const output = await Promise.all(build.outputs.map((artifact) => artifact.text()));
    const bundled = output.join('\n');
    // The stdio transport and its child-process dependencies belong behind `armorer/tool-sources`.
    expect(bundled).not.toContain('child_process');
    expect(bundled).not.toContain('cross-spawn');
    expect(bundled).not.toMatch(/from\s*["']node:/);
  });

  it('exposes lazy provider import helpers on createToolbox', () => {
    expect(root.createToolbox.fromProvider).toBeDefined();
    expect(root.createToolbox.fromOpenAITools).toBeDefined();
    expect(root.createToolbox.fromAnthropicTools).toBeDefined();
    expect(root.createToolbox.fromGeminiTools).toBeDefined();
  });

  it('keeps the root declaration independent of the optional OpenAI Agents SDK', () => {
    expect(rootSource).not.toContain('./adapters/open-ai/agents');
    expect(rootSource).toContain("export { createToolbox } from './create-toolbox';");
  });

  it('keeps the OpenAI Agents adapter available through its explicit subpath', () => {
    expect(openAIAgentsAdapterSource).toContain("typeof import('@openai/agents')");
    expect(openAIAgentsAdapterSource).toContain('armorer/open-ai/agents');
  });

  it('keeps Bun-only coding tools out of the browser-facing root', () => {
    expect(rootSource).not.toContain("export * from './coding'");
    expect('createCodingTools' in root).toBe(false);
    expect('createCodingToolbox' in root).toBe(false);
    expect(coding.createCodingTools).toBeFunction();
    expect(coding.createCodingToolbox).toBeFunction();
  });

  it('exposes shared interop materializers and types on the root surface', () => {
    expect(root.materializeToolCall).toBeDefined();
    expect(root.materializeToolCalls).toBeDefined();
    expect(root.materializeToolResult).toBeDefined();
    expect(root.materializeToolResultsAsync).toBeDefined();
    expect(rootSource).toContain('ExternalExecutionProjection');
  });

  it('documents the durable approval state store contract', () => {
    const approvalSection = readme.slice(
      readme.indexOf('## Approval Flows'),
      readme.indexOf('### Request Authority and Execution Projections'),
    );

    expect(approvalSection).toContain('approvalStateStore');
    expect(approvalSection).toContain('sharedDurableApprovalStore');
    expect(approvalSection).toContain('recoveredToolbox.resumeApproval');
    for (const method of [
      'issue(binding)',
      'reserve(binding, context, now)',
      'commit(binding)',
      'release(binding)',
      'consume(binding, context, now)',
      'revoke(binding)',
      'state(binding)',
    ]) {
      expect(approvalSection).toContain(method);
    }
  });

  it('uses dynamic imports for provider adapters in createToolbox', () => {
    const source = readFileSync(
      new URL('../src/toolbox-provider-factories.ts', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(/await import\('\.\/adapters\/openai'\)/);
    expect(source).toMatch(/await import\(\s*'\.\/adapters\/anthropic'\s*\)/);
    expect(source).toMatch(/await import\('\.\/adapters\/gemini'\)/);
    expect(source).not.toMatch(
      /import\s+\{[^}]+\}\s+from\s+['"]\.\/adapters\/(?:openai|anthropic|gemini)['"]/,
    );
    expect(source).not.toMatch(
      /import\s+\*\s+as\s+\w+\s+from\s+['"]\.\/adapters\/(?:openai|anthropic|gemini)['"]/,
    );
  });
});
