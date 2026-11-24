import { expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('packed native MCP and shared HTTP work in a clean dual-era consumer', async () => {
  const repository = resolve(import.meta.dir, '../../..');
  const directory = await mkdtemp(join(tmpdir(), 'armorer-mcp-consumer-'));
  const run = async (command: string[], cwd: string) => {
    const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exit !== 0) throw new Error(`${command.join(' ')} failed (${exit}): ${stderr}\n${stdout}`);
    return stdout;
  };
  try {
    await run(
      [
        'bun',
        'scripts/pack-agent-library-release.ts',
        '--package',
        'armorer',
        '--version',
        '0.0.0',
        '--outdir',
        directory,
      ],
      repository,
    );
    const sharedDirectory = join(directory, 'shared-http');
    const manifest = JSON.parse(
      await readFile(join(repository, 'packages/mcp/package.json'), 'utf8'),
    );
    await mkdir(join(sharedDirectory, 'src'), { recursive: true });
    await copyFile(
      join(repository, 'packages/mcp/src/http.ts'),
      join(sharedDirectory, 'src/http.ts'),
    );
    await writeFile(
      join(sharedDirectory, 'package.json'),
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        private: manifest.private,
        type: manifest.type,
        sideEffects: manifest.sideEffects,
        exports: { './http': manifest.exports['./http'] },
      }),
    );
    await run(
      ['bun', 'pm', 'pack', '--ignore-scripts', '--destination', directory, '--quiet'],
      sharedDirectory,
    );
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'mcp-consumer',
        private: true,
        type: 'module',
        dependencies: {
          armorer: 'file:./armorer-0.0.0.tgz',
          '@lostgradient/mcp': 'file:./lostgradient-mcp-0.0.0.tgz',
          '@modelcontextprotocol/client': '2.4.0',
          zod: '4.3.6',
        },
      }),
    );
    await run(['bun', 'install'], directory);
    const graph = await run(['bun', 'pm', 'ls', '--all'], directory);
    expect(graph).not.toContain('velveteen');
    expect(graph).not.toContain('backchannel');
    await writeFile(
      join(directory, 'consumer.ts'),
      `
import { createTool, createToolbox } from 'armorer';
import { createToolboxMcpHandler } from 'armorer/mcp/http';
import { createProtectedHttpHandler } from '@lostgradient/mcp/http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
const authorization = { origin: 'https://equipment.example.com', resourcePath: '/mcp', issuer: 'https://issuer.example.com', scopes: ['read'],
  async verifyAccessToken() { return { issuer: 'https://issuer.example.com', audience: 'https://equipment.example.com/mcp', expiresAt: Date.now() + 60000, subject: 'user', grantId: 'grant', clientId: 'client', tenant: 'tenant', scopes: ['read'] }; },
  async resolvePrincipal() { return { delegableScopes: ['read'] }; } };
const shared = createProtectedHttpHandler({ ...authorization, dispatch: () => new Response('shared') });
if ((await shared(new Request('https://equipment.example.com/mcp', { headers: { authorization: 'Bearer valid' } }))).status !== 200) throw new Error('shared HTTP failed');
const tool = createTool({ name: 'read', version: '1', description: 'read', input: z.object({}), async execute() { return 'asset'; } });
const endpoint = await createToolboxMcpHandler(createToolbox([tool]), { tools: [{ id: tool.id, name: 'equipment.read', scopes: ['read'] }], authorization,
  requestContext: () => ({ authority: { principalId: 'user', tenantId: 'tenant', ownerId: 'user', capabilities: ['read'], authorizationRevision: '1' } }) });
const server = Bun.serve({ port: 0, fetch: endpoint.fetch });
try { for (const version of ['2025-11-25', '2026-07-28']) {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', server.url), { fetch: (url, init) => { const headers = new Headers(init?.headers); headers.set('authorization', 'Bearer valid'); return fetch(url, { ...init, headers }); } });
  const client = new Client({ name: 'consumer', version: '1' }, { supportedProtocolVersions: [version], versionNegotiation: { mode: version === '2025-11-25' ? 'legacy' : { pin: version } } });
  try { await client.connect(transport); if (client.getNegotiatedProtocolVersion() !== version) throw new Error('wrong protocol: ' + version); const result = await client.callTool({ name: 'equipment.read', arguments: {} }); if (result.isError || !JSON.stringify(result).includes('asset')) throw new Error('read failed: ' + version); }
  finally { await client.close(); }
} } finally { server.stop(true); await endpoint.close(); }
`,
    );
    await run(['bun', 'consumer.ts'], directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
