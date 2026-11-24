/** Source installed into the detached starter after its package archives are installed. */
export const catalogConsumerFiles: Record<string, string> = {
  "src/catalog.ts": `import { defineOperation } from '@lostgradient/backchannel';
import { z } from 'zod';
const transports = { http: true, jsonRpcHttp: true, jsonRpcStdio: true, jsonRpcWebSocket: true } as const;
const common = { tags: ['Equipment'], mcpExposable: false, transports, unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' } } as const;
export const state = { reads: [] as string[], inspections: 0, commands: 0, aborted: false, settledA: false, release: Promise.withResolvers<void>() };
export const read = defineOperation({ ...common, name: 'equipment.items.get', summary: 'Read equipment', destructive: false, inputSchema: z.object({ id: z.string() }), outputSchema: z.object({ id: z.string() }), access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['equipment:read'] } }, behavior: { kind: 'read', key: ['id'] }, invoke: async ({ input, signal }) => { state.reads.push(input.id); if (input.id === 'A') { signal?.addEventListener('abort', () => { state.aborted = true; }, { once: true }); await state.release.promise; state.settledA = true; } return input; } });
export const command = defineOperation({ ...common, name: 'equipment.items.reserve', summary: 'Reserve equipment', destructive: true, inputSchema: z.object({ id: z.string() }), outputSchema: z.object({ id: z.string() }), access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['equipment:read'] } }, behavior: { kind: 'command', responseDisposition: 'one-time' }, invoke: async ({ input }) => { state.commands++; return input; } });
export const extra = defineOperation({ ...common, name: 'equipment.items.inspect', summary: 'Inspect equipment', destructive: false, inputSchema: z.object({ id: z.string() }), outputSchema: z.object({ id: z.string() }), access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['equipment:read'] } }, behavior: { kind: 'read', key: ['id'] }, invoke: async ({ input }) => { state.inspections++; return input; } });
export const operations = process.env.EXTRA_OPERATION ? [read, command, extra] : [read, command];
`,
  "src/generate.ts": `import { mkdir, writeFile } from 'node:fs/promises';
import { createOperationRegistry } from '@lostgradient/backchannel';
import { snapshotOperationCatalog } from '@lostgradient/backchannel/internals';
import { createOperationClientSources } from '@lostgradient/backchannel/generator';
import { operations } from './catalog.ts';
const snapshot = snapshotOperationCatalog({ operations: createOperationRegistry(operations).list(), restBindings: [] });
const sources = await createOperationClientSources(snapshot, { packageName: 'equipment-consumer', serverName: 'Equipment', factoryName: 'createEquipmentClient', outputDirectory: 'src/generated', portableEntries: true, svelte: true, format: async (source) => source });
await mkdir('src/generated', { recursive: true });
for (const [name, source] of sources) await writeFile('src/generated/' + name, source);
`,
  "src/transport.ts": `import { httpJsonRpcTransport } from '@lostgradient/backchannel/client';
export const transport = httpJsonRpcTransport({ baseUrl: '/service', fetch: async (input, init) => { const response = await fetch(input, init); if (typeof init?.body === 'string' && init.body.includes('equipment.items.reserve')) throw new Error('response lost'); return response; } });
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
{#key data.item.id}<EquipmentProvider scope="actor" {cache} {transport}><Item item={data.item} /></EquipmentProvider>{/key}
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
