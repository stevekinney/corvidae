/** Source installed into the detached starter after its package archives are installed. */
export const catalogConsumerFiles: Record<string, string> = {
  "probe/standalone-velveteen.ts": `import { createApplication } from '@lostgradient/velveteen/server';
const node = { id: '/', directory: '', parentId: null, params: [], page: { component: 'page.svelte' } };
const route = (id: string) => ({ id, pattern: '^' + id + '$', params: [], node: 0, leaf: 0, ancestors: [0], layouts: [], errors: [null] });
const routing = { version: 1, nodes: [node], routes: [route('/'), route('/equipment')] };
const app = await createApplication({ generation: { directory: '.', manifest: { version: 1, basePath: '', routing, client: { file: '', url: '', stylesheets: [], nodes: {} }, server: { file: '', nodes: {} }, routes: {}, assets: [], outputs: [] } } as never, registry: { manifest: routing, nodes: [{ page: async () => ({ default: {} }) }], Root: {}, render: () => ({ body: 'equipment page', head: '' }) } as never });
try { for (const path of ['/', '/equipment']) { const response = await app.fetch(new Request('http://consumer.test' + path)); if (response.status !== 200 || !(await response.text()).includes('equipment page')) throw new Error('standalone page failed ' + path); } } finally { await app.dispose(); }
console.log('standalone Velveteen passed');
`,
  "probe/standalone-armorer.ts": `import { createTool, createToolbox } from 'armorer';
import { createToolboxMcpHandler } from 'armorer/mcp/http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
let calls = 0;
const lookup = createTool({ name: 'lookup', version: '1', description: 'Lookup', input: z.object({}), execute: async () => { calls++; return { name: 'Camera' }; } });
const handler = await createToolboxMcpHandler(createToolbox([lookup]), { tools: [{ id: lookup.id, name: 'equipment.lookup', scopes: ['read'] }], resources: (server) => server.registerResource('equipment', 'equipment://current', { title: 'Equipment' }, async () => ({ contents: [{ uri: 'equipment://current', text: 'Camera' }] })), authorization: { origin: 'https://consumer.test', resourcePath: '/mcp', issuer: 'https://issuer.test', scopes: ['read'], async verifyAccessToken() { return { issuer: 'https://issuer.test', audience: 'https://consumer.test/mcp', expiresAt: Date.now() + 60000, subject: 'consumer', grantId: 'grant', clientId: 'client', tenant: 'tenant', scopes: ['read'] }; }, async resolvePrincipal() { return { delegableScopes: ['read'] }; } }, requestContext: () => ({ authority: { principalId: 'consumer', tenantId: 'tenant', ownerId: 'consumer', capabilities: [], authorizationRevision: '1' } }) });
try {
  const denied = await handler.fetch(new Request('https://consumer.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'equipment.lookup', arguments: {} } }) }));
  if (denied.status !== 401 || calls !== 0) throw new Error('standalone native denial invoked callback');
  const client = new Client({ name: 'standalone', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('https://consumer.test/mcp'), { fetch: (url, init) => { const headers = new Headers(init?.headers); headers.set('authorization', 'Bearer valid'); return handler.fetch(new Request(url, { ...init, headers })); } }));
    if (!(await client.listTools()).tools.some((tool) => tool.name === 'equipment.lookup')) throw new Error('standalone native tool missing');
    const result = await client.callTool({ name: 'equipment.lookup', arguments: {} });
    if (result.isError || calls !== 1 || !JSON.stringify(result).includes('Camera')) throw new Error('standalone native lookup failed');
    if (!JSON.stringify(await client.readResource({ uri: 'equipment://current' })).includes('Camera')) throw new Error('standalone native resource failed');
  } finally { await client.close(); }
} finally { await handler.close(); }
console.log('standalone Armorer passed');
`,
  "probe/standalone-backchannel.ts": `import { createOperationHandler, defineOperation, principalFromApiKey } from '@lostgradient/backchannel';
import { z } from 'zod';
let name = 'Camera', reads = 0, writes = 0;
const common = { inputSchema: z.object({}), outputSchema: z.object({ name: z.string() }), mcpExposable: true, transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false }, unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' } } as const;
const operations = [
  defineOperation({ ...common, name: 'equipment.lookup', summary: 'Lookup', destructive: false, access: { kind: 'scoped', scopes: { kind: 'allOf', scopes: ['read'] } }, invoke: async () => { reads++; return { name }; } }),
  defineOperation({ ...common, name: 'equipment.rename', summary: 'Rename', destructive: true, access: { kind: 'scoped', scopes: { kind: 'allOf', scopes: ['write'] } }, invoke: async () => { writes++; name = 'Studio camera'; return { name }; } }),
];
const mcp = process.argv[2] === 'mcp';
const mounts = mcp ? [(await import('@lostgradient/backchannel-mcp')).createOperationMcpMount({ serverInfo: { name: 'equipment', version: '1' } })] : [];
const handler = createOperationHandler({ operations, mounts, host: {}, authenticate: async (request) => ({ method: 'api-key', principal: principalFromApiKey({ subject: 'consumer', scopes: request.headers.get('x-role') === 'writer' ? ['read', 'write'] : ['read'] }) }) });
const call = async (method: string, role: string) => (await handler(new Request('http://consumer.test/jsonrpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-role': role }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) }))).json();
if ((await call('equipment.lookup', 'reader')).result?.name !== 'Camera' || reads !== 1) throw new Error('standalone lookup failed');
if (!(await call('equipment.rename', 'reader')).error || writes !== 0) throw new Error('standalone denial invoked callback');
if ((await call('equipment.rename', 'writer')).result?.name !== 'Studio camera' || writes !== 1) throw new Error('standalone rename failed');
if (mcp) {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'standalone', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://consumer.test/mcp'), { fetch: (url, init) => handler(new Request(url, init)) }));
    if (!(await client.listTools()).tools.some((tool) => tool.name === 'equipment.lookup')) throw new Error('headless tool missing');
    const before = reads;
    const result = await client.callTool({ name: 'equipment.lookup', arguments: {} });
    if (result.isError || reads !== before + 1) throw new Error('headless lookup failed');
    const rejected = await client.callTool({ name: 'equipment.rename', arguments: {} });
    if (!rejected.isError || writes !== 1) throw new Error('headless denial invoked callback');
  } finally { await client.close(); }
}
console.log('standalone Backchannel passed');
`,
  "probe/mounted.ts": `import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const base = process.argv[2]!;
for (const [path, name] of [['/service/mcp', 'equipment.lookup'], ['/native', 'lookup']] as const) {
  const count = async () => (await (await fetch(new URL('/service/control', base))).json()).equipment.reads;
  const deniedBefore = await count();
  const denied = await fetch(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { assetId: 'CAM-7' } } }) });
  if (denied.status !== 401 || await count() !== deniedBefore) throw new Error('mounted denial invoked callback');
  const client = new Client({ name: 'mounted-consumer', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(path, base), { fetch: (url, init) => { const headers = new Headers(init?.headers); headers.set('cookie', 'actor=1'); return fetch(url, { ...init, headers }); } }));
    const tools = (await client.listTools()).tools;
    if (!tools.some((tool) => tool.name === name)) throw new Error('missing mounted tool ' + name);
    const before = await count();
    const result = await client.callTool({ name, arguments: { assetId: 'CAM-7' } });
    if (result.isError || await count() !== before + 1 || !JSON.stringify(result).includes('Camera')) throw new Error('mounted lookup failed ' + name);
  } finally { await client.close(); }
}
console.log('both mounted MCP services passed');
`,
  "probe/read-equipment.ts": `import { createEquipmentClientWithFetch } from '../src/generated/fetch-operation-client.generated.ts';
const baseUrl = new URL('/service', process.argv[2]).href;
const client = createEquipmentClientWithFetch({ baseUrl, fetch: (input, init) => { const headers = new Headers(init?.headers); headers.set('cookie', 'actor=1'); return fetch(input, { ...init, headers }); } });
const result = await client['equipment.lookup']({ assetId: 'CAM-7' });
if (result.name !== 'Studio camera') throw new Error('generated script client read the wrong name');
console.log(JSON.stringify(result));
`,
  "probe/remote.ts": `import { createInMemoryMcpOAuthTokenStorage, createMCP, createToolbox } from 'armorer';
import { completeToolSourceAuthorization, loadToolSource } from 'armorer/tool-sources';
import { equipment, lookup } from '../src/equipment.ts';

const endpoint = await createMCP(createToolbox([lookup]), { serverInfo: { name: 'equipment', version: '1' } });
let challenge = '', redirectUri = '', expectedResource = '', tokenIssued = false;
const server = Bun.serve({ port: 0, async fetch(request) {
  const issuer = server.url.href;
  const url = new URL(request.url);
  if (url.pathname === '/.well-known/oauth-protected-resource') return Response.json({ resource: issuer, authorization_servers: [issuer] });
  if (url.pathname === '/.well-known/oauth-authorization-server') return Response.json({ issuer, authorization_endpoint: issuer + 'authorize', token_endpoint: issuer + 'token', registration_endpoint: issuer + 'register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true });
  if (url.pathname === '/register') return Response.json({ ...await request.json(), client_id: 'consumer', client_id_issued_at: Math.floor(Date.now() / 1000) });
  if (url.pathname === '/authorize') {
    challenge = url.searchParams.get('code_challenge') ?? '';
    redirectUri = url.searchParams.get('redirect_uri') ?? '';
    expectedResource = url.searchParams.get('resource') ?? '';
    if (!challenge || expectedResource !== issuer) return new Response('invalid authorization', { status: 400 });
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', 'equipment-code'); callback.searchParams.set('state', url.searchParams.get('state') ?? ''); callback.searchParams.set('iss', issuer);
    return Response.redirect(callback, 302);
  }
  if (url.pathname === '/token') {
    const body = new URLSearchParams(await request.text());
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier') ?? ''));
    if (body.get('code') !== 'equipment-code' || body.get('redirect_uri') !== redirectUri || body.get('resource') !== expectedResource || Buffer.from(hash).toString('base64url') !== challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    tokenIssued = true; return Response.json({ access_token: 'equipment-token', token_type: 'Bearer', expires_in: 3600 });
  }
  if (url.pathname === '/') {
    if (!tokenIssued || request.headers.get('authorization') !== 'Bearer equipment-token') return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="' + issuer + '.well-known/oauth-protected-resource"' } });
    return endpoint.fetch(request);
  }
  return new Response('not found', { status: 404 });
} });
const source = { id: 'remote-equipment', kind: 'mcp', transport: { type: 'http', url: server.url.href, authentication: { type: 'oauth' } } } as const;
const tokenStorage = createInMemoryMcpOAuthTokenStorage();
let authorizationUrl: URL | undefined;
const oauth = { tokenStorage: () => tokenStorage, redirectUrl: () => 'http://127.0.0.1:9999/callback', onAuthorizationRequired: (_id: string, url: URL) => { authorizationUrl = url; } };
try {
  let rejected = false;
  try { await loadToolSource(source, { oauth, resolveCredential: () => undefined }); } catch { rejected = true; }
  if (!rejected || !authorizationUrl) throw new Error('authorization was not requested');
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  const callbackUrl = response.headers.get('location');
  if (!callbackUrl) throw new Error('missing authorization callback');
  await completeToolSourceAuthorization(source, { oauth, callbackUrl });
  const loaded = await loadToolSource(source, { oauth, resolveCredential: () => undefined });
  try {
    if (loaded.tools.length !== 1) throw new Error('wrong remote tool count');
    const before = equipment.reads;
    const result = await createToolbox(loaded.tools).execute({ name: loaded.tools[0]!.id, arguments: { assetId: 'CAM-7' } });
    if (result.outcome !== 'success' || equipment.reads !== before + 1 || !JSON.stringify(result).includes('Camera')) throw new Error('remote lookup failed');
  } finally { await loaded.close(); }
  const beforeClosedCall = equipment.reads;
  let closedCallFailed = false;
  try { await loaded.tools[0]!.execute({ assetId: 'CAM-7' }); } catch { closedCallFailed = true; }
  if (!closedCallFailed || equipment.reads !== beforeClosedCall) throw new Error('remote source remained usable after close');
} finally { server.stop(true); await endpoint.close(); }
console.log('installed OAuth tool source passed');
`,
  "probe/equipment.ts": `import { createOperationHandler, principalFromApiKey } from '@lostgradient/backchannel';
import { createOperationMcpMount } from '@lostgradient/backchannel-mcp';
import { createToolboxMcpHandler } from 'armorer/mcp/http';
import { fromMcpClientTools } from 'armorer';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { equipment, lookup, operations, toolbox } from '../src/equipment.ts';

for (const [version, mode] of [['2025-11-25', 'legacy'], ['2026-07-28', { pin: '2026-07-28' }]] as const) {
  let writer = false;
  const handler = createOperationHandler({ operations, host: {}, authenticate: async () => ({ method: 'api-key', principal: principalFromApiKey({ subject: 'consumer', scopes: writer ? ['equipment:read', 'equipment:write'] : ['equipment:read'] }) }), mounts: [createOperationMcpMount({ serverInfo: { name: 'equipment', version: '1.0.0' } })] });
  const client = new Client({ name: 'equipment-consumer', version: '1.0.0' }, { versionNegotiation: { mode } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://equipment.test/mcp'), { fetch: (url, init) => handler(new Request(url, init)) }));
    if (client.getNegotiatedProtocolVersion() !== version) throw new Error('wrong MCP protocol');
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(['equipment.lookup', 'equipment.rename'])) throw new Error('wrong MCP tools');
    let unavailable = false;
    try { unavailable = Boolean((await client.callTool({ name: 'equipment.hidden', arguments: { assetId: 'CAM-7' } })).isError); } catch { unavailable = true; }
    if (!unavailable || equipment.hidden !== 0) throw new Error('unselected tool was available');
    let before = equipment.reads;
    const found = await client.callTool({ name: 'equipment.lookup', arguments: { assetId: 'CAM-7' } });
    if (found.isError || equipment.reads !== before + 1 || JSON.stringify(found.structuredContent) !== JSON.stringify({ assetId: 'CAM-7', name: equipment.name })) throw new Error('lookup failed');
    const imported = (await fromMcpClientTools(client)).find((tool) => tool.name === 'equipment.lookup');
    if (!imported || !imported.configuration.metadata?.readOnly) throw new Error('imported lookup lost its read-only hint');
    before = equipment.reads;
    const importedResult = await imported.execute({ assetId: 'CAM-7' });
    if (equipment.reads !== before + 1 || !JSON.stringify(importedResult).includes(equipment.name)) throw new Error('imported lookup failed');
    before = equipment.writes;
    const denied = await client.callTool({ name: 'equipment.rename', arguments: { assetId: 'CAM-7', name: 'Denied' } });
    if (!denied.isError || equipment.writes !== before) throw new Error('denied rename invoked callback');
    writer = true;
    const renamed = await client.callTool({ name: 'equipment.rename', arguments: { assetId: 'CAM-7', name: 'Studio camera' } });
    if (renamed.isError || equipment.writes !== before + 1 || equipment.name !== 'Studio camera') throw new Error('rename failed');
  } finally { await client.close(); }
}
const native = await createToolboxMcpHandler(toolbox, {
  tools: [{ id: lookup.id, name: 'equipment.lookup', scopes: ['equipment:read'] }],
  resources: (server) => server.registerResource('equipment', 'equipment://current', { title: 'Equipment' }, async () => ({ contents: [{ uri: 'equipment://current', text: equipment.name }] })),
  authorization: { origin: 'https://equipment.example', resourcePath: '/mcp', issuer: 'https://issuer.example', scopes: ['equipment:read'], async verifyAccessToken() { return { issuer: 'https://issuer.example', audience: 'https://equipment.example/mcp', expiresAt: Date.now() + 60000, subject: 'consumer', grantId: 'grant', clientId: 'client', tenant: 'tenant', scopes: ['equipment:read'] }; }, async resolvePrincipal() { return { delegableScopes: ['equipment:read'] }; } },
  requestContext: () => ({ authority: { principalId: 'consumer', tenantId: 'tenant', ownerId: 'consumer', capabilities: [], authorizationRevision: '1' } }),
});
try {
  const beforeDenied = equipment.reads;
  const denied = await native.fetch(new Request('https://equipment.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'equipment.lookup', arguments: { assetId: 'CAM-7' } } }) }));
  if (denied.status !== 401 || equipment.reads !== beforeDenied) throw new Error('native denied request invoked callback');
  for (const [version, mode] of [['2025-11-25', 'legacy'], ['2026-07-28', { pin: '2026-07-28' }]] as const) {
    const client = new Client({ name: 'native-consumer', version: '1.0.0' }, { versionNegotiation: { mode } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('https://equipment.example/mcp'), { fetch: (url, init) => { const headers = new Headers(init?.headers); headers.set('authorization', 'Bearer valid'); return native.fetch(new Request(url, { ...init, headers })); } }));
      if (client.getNegotiatedProtocolVersion() !== version) throw new Error('wrong native protocol');
      const tools = (await client.listTools()).tools;
      if (tools.length !== 1 || tools[0]?.name !== 'equipment.lookup') throw new Error('wrong native tools');
      const resource = await client.readResource({ uri: 'equipment://current' });
      if (!JSON.stringify(resource).includes('Studio camera')) throw new Error('native resource failed');
      const before = equipment.reads;
      const result = await client.callTool({ name: 'equipment.lookup', arguments: { assetId: 'CAM-7' } });
      if (result.isError || equipment.reads !== before + 1 || !JSON.stringify(result).includes('Studio camera')) throw new Error('native lookup failed');
    } finally { await client.close(); }
  }
} finally { await native.close(); }
console.log('installed projected catalog MCP: both eras passed');
`,
  "src/equipment.ts": `import { createTool, createToolbox } from 'armorer';
import { operationsFromToolbox } from '@lostgradient/backchannel-armorer';
import { z } from 'zod';

export const equipment = { assetId: 'CAM-7', name: 'Camera', reads: 0, writes: 0, hidden: 0 };
const input = z.object({ assetId: z.string() });
const output = input.extend({ name: z.string() });
export const lookup = createTool({ namespace: 'equipment', version: '1.0.0', name: 'lookup', description: 'Look up equipment', input, metadata: { readOnly: true }, execute: async () => { equipment.reads++; return { assetId: equipment.assetId, name: equipment.name }; } });
export const rename = createTool({ namespace: 'equipment', version: '1.0.0', name: 'rename', description: 'Rename equipment', input: input.extend({ name: z.string().min(1) }), metadata: { mutates: true }, execute: async ({ name }) => { equipment.writes++; equipment.name = name; return { assetId: equipment.assetId, name: equipment.name }; } });
const hidden = createTool({ namespace: 'equipment', version: '1.0.0', name: 'hidden', description: 'Unselected tool', input, execute: async () => { equipment.hidden++; return { assetId: equipment.assetId, name: equipment.name }; } });
export const toolbox = createToolbox([lookup, rename, hidden]);
export const operations = operationsFromToolbox(toolbox, [
  { tool: lookup.id, name: 'equipment.lookup', scopes: ['equipment:read'], outputSchema: output, mcpExposable: true, behavior: { kind: 'read', key: ['assetId'] } },
  { tool: rename.id, name: 'equipment.rename', scopes: ['equipment:write'], outputSchema: output, mcpExposable: true, behavior: { kind: 'command', invalidates: ['equipment.lookup'] } },
], { requestContext: () => ({ authority: { principalId: 'consumer', tenantId: 'tenant', ownerId: 'consumer', capabilities: [], authorizationRevision: '1' } }) });
`,
  "src/catalog.ts": `import { defineOperation } from '@lostgradient/backchannel';
import { z } from 'zod';
const transports = { http: true, jsonRpcHttp: true, jsonRpcStdio: true, jsonRpcWebSocket: true } as const;
const common = { tags: ['Equipment'], mcpExposable: false, transports, unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' } } as const;
export const state = { reads: [] as string[], inspections: 0, commands: 0, admittedLookups: 0, aborted: false, settledA: false, release: Promise.withResolvers<void>() };
export const read = defineOperation({ ...common, name: 'equipment.items.get', summary: 'Read equipment', destructive: false, inputSchema: z.object({ id: z.string() }), outputSchema: z.object({ id: z.string() }), access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['equipment:read'] } }, behavior: { kind: 'read', key: ['id'] }, invoke: async ({ input, signal }) => { state.reads.push(input.id); if (input.id === 'A') { signal?.addEventListener('abort', () => { state.aborted = true; }, { once: true }); await state.release.promise; state.settledA = true; } return input; } });
export const command = defineOperation({ ...common, name: 'equipment.items.reserve', summary: 'Reserve equipment', destructive: true, inputSchema: z.object({ id: z.string() }), outputSchema: z.object({ id: z.string() }), access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['equipment:read'] } }, behavior: { kind: 'command', responseDisposition: 'one-time' }, invoke: async ({ input }) => { state.commands++; return input; } });
export const extra = defineOperation({ ...common, name: 'equipment.items.inspect', summary: 'Inspect equipment', destructive: false, inputSchema: z.object({ id: z.string() }), outputSchema: z.object({ id: z.string() }), access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['equipment:read'] } }, behavior: { kind: 'read', key: ['id'] }, invoke: async ({ input }) => { state.inspections++; return input; } });
export const operations = [read, command];
`,
  "src/generate.ts": `import { mkdir, writeFile } from 'node:fs/promises';
import { createOperationRegistry } from '@lostgradient/backchannel';
import { snapshotOperationCatalog } from '@lostgradient/backchannel/internals';
import { createOperationClientSources } from '@lostgradient/backchannel/generator';
import { operations } from './catalog.ts';
import { operations as equipmentOperations } from './equipment.ts';
const snapshot = snapshotOperationCatalog({ operations: createOperationRegistry([...operations, ...equipmentOperations]).list(), restBindings: [] });
const sources = await createOperationClientSources(snapshot, { packageName: 'equipment-consumer', serverName: 'Equipment', factoryName: 'createEquipmentClient', outputDirectory: 'src/generated', portableEntries: true, svelte: true, format: async (source) => source });
await mkdir('src/generated', { recursive: true });
for (const [name, source] of sources) await writeFile('src/generated/' + name, source);
`,
  "src/transport.ts": `import { httpJsonRpcTransport } from '@lostgradient/backchannel/client';
export const transport = httpJsonRpcTransport({ baseUrl: '/service', fetch: async (input, init) => { const response = await fetch(input, init); if (typeof init?.body === 'string' && init.body.includes('equipment.items.reserve')) throw new Error('response lost'); return response; } });
`,
  "src/routes/equipment/+page.ts": `import { createEquipmentClientWithFetch } from '../../generated/fetch-operation-client.generated.ts';
import type { PageLoad } from './$types';
export const load = (async ({ fetch }) => ({ item: await createEquipmentClientWithFetch({ baseUrl: '/service', fetch })['equipment.lookup']({ assetId: 'CAM-7' }) })) satisfies PageLoad;
`,
  "src/routes/equipment/+page.svelte": `<script lang="ts">
  import { QueryClient } from '@tanstack/svelte-query';
  import { EquipmentProvider } from '../../generated/operation-client.svelte.ts';
  import { transport } from '../../transport.ts';
  import Item from './Item.svelte';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const cache = new QueryClient();
</script>
<EquipmentProvider scope="actor" {cache} {transport}><Item item={data.item} /></EquipmentProvider>
`,
  "src/routes/equipment/Item.svelte": `<script lang="ts">
  import { untrack } from 'svelte';
  import { activateResource } from '@lostgradient/backchannel-svelte';
  import { getEquipmentHost, useEquipmentLookup, useEquipmentRename } from '../../generated/operation-client.svelte.ts';
  let { item }: { item: { assetId: string; name: string } } = $props();
  const host = getEquipmentHost();
  untrack(() => host.seed('equipment.lookup', { assetId: item.assetId }, item, (value): value is { assetId: string; name: string } => typeof value === 'object' && value !== null && 'assetId' in value && 'name' in value));
  const read = useEquipmentLookup(host, () => ({ assetId: item.assetId }));
  const rename = useEquipmentRename(host);
</script>
<h1 id="equipment-name" {@attach activateResource(read)}>{read.data?.name}</h1>
<button id="equipment-rename" onclick={() => void rename.mutateAsync({ assetId: item.assetId, name: 'Studio camera' })}>Rename</button>
`,
  "src/routes/items/[id]/+page.ts": `import { createEquipmentClientWithFetch } from '../../../generated/fetch-operation-client.generated.ts';
import type { PageLoad } from './$types';
export const load = (async ({ fetch, params }) => { const client = createEquipmentClientWithFetch({ baseUrl: '/service', fetch }); return { item: await client['equipment.items.get']({ id: params.id }), inspection: await client['equipment.items.inspect']({ id: params.id }) }; }) satisfies PageLoad;
`,
  "src/routes/items/[id]/+page.svelte": `<script lang="ts">
  import { QueryClient } from '@tanstack/svelte-query';
  import { EquipmentProvider } from '../../../generated/operation-client.svelte.ts';
  import { transport } from '../../../transport.ts';
  import Item from './Item.svelte';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  const cache = new QueryClient();
</script>
<a href="/items/A">A</a><a href="/items/B">B</a>
<EquipmentProvider scope="actor" {cache} {transport}>{#key data.item.id}<Item item={data.item} />{/key}</EquipmentProvider>
`,
  "src/routes/items/[id]/Item.svelte": `<script lang="ts">
  import { untrack } from 'svelte';
  import { activateResource } from '@lostgradient/backchannel-svelte';
  import { getEquipmentHost, useEquipmentItemsGet, useEquipmentItemsInspect, useEquipmentItemsReserve } from '../../../generated/operation-client.svelte.ts';
  let { item }: { item: { id: string } } = $props();
  const host = getEquipmentHost();
  untrack(() => host.seed('equipment.items.get', { id: item.id }, item, (value): value is { id: string } => typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'));
  const read = useEquipmentItemsGet(host, () => ({ id: item.id }));
  const inspection = useEquipmentItemsInspect(host, () => ({ id: item.id }));
  const command = useEquipmentItemsReserve(host);
  const fault = command.fault;
</script>
<output id="item" {@attach activateResource(read)}>{read.data?.id}</output>
<output id="inspection" {@attach activateResource(inspection)}>{inspection.data?.id}</output>
<button id="reserve" onclick={() => void command.mutateAsync({ id: item.id }).catch(() => {})}>Reserve</button>
<output id="fault">{$fault ?? ''}</output>
`,
};
