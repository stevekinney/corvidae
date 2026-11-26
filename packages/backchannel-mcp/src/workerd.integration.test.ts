import { withWorker } from '@lostgradient/workerd-testing';
import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
} from '@modelcontextprotocol/client';
import { expect, test } from 'bun:test';

const entry = new URL('./workerd-fixture.ts', import.meta.url).pathname;
const endpoint = new URL('https://catalog.test/mcp');

type NegotiationMode = NonNullable<NonNullable<ClientOptions['versionNegotiation']>['mode']>;

const protocolEras: ReadonlyArray<{
  name: string;
  mode: NegotiationMode;
  version: string;
}> = [
  { name: '2025-11-25', mode: 'legacy', version: '2025-11-25' },
  { name: '2026-07-28', mode: { pin: '2026-07-28' }, version: '2026-07-28' },
];

for (const era of protocolEras) {
  test(`serves an operation catalog over Streamable HTTP from workerd (${era.name})`, async () => {
    await withWorker({ entry }, async ({ dispatchFetch }) => {
      const transport = new StreamableHTTPClientTransport(endpoint, {
        fetch: async (url, init) => {
          const response = await dispatchFetch(url.toString(), init as never);
          return new Response(await response.arrayBuffer(), {
            status: response.status,
            statusText: response.statusText,
            headers: Array.from(response.headers.entries()),
          });
        },
      });
      const client = new Client(
        { name: 'workerd-catalog-client', version: '1.0.0' },
        { versionNegotiation: { mode: era.mode } },
      );
      try {
        await client.connect(transport);
        expect(client.getNegotiatedProtocolVersion()).toBe(era.version);
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({
          name: 'workerd.echo',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        });
        const result = await client.callTool({
          name: 'workerd.echo',
          arguments: { message: `hello ${era.name}` },
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({ message: `hello ${era.name}` });
      } finally {
        await client.close();
      }
    });
  });
}
