import { createOperationHandler, defineOperation } from '@lostgradient/backchannel';
import { z } from 'zod';

import { createOperationMcpMount } from './operation-tools.ts';

const catalog = createOperationHandler({
  operations: [
    defineOperation({
      name: 'workerd.echo',
      mcpExposable: true,
      summary: 'Echo a message from workerd.',
      destructive: false,
      behavior: { kind: 'read' },
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ message: z.string() }),
      access: { kind: 'public' },
      transports: {
        http: false,
        jsonRpcHttp: true,
        jsonRpcWebSocket: false,
        jsonRpcStdio: false,
      },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async ({ input }) => ({ message: input.message }),
    }),
  ],
  host: {},
  mounts: [
    createOperationMcpMount({
      serverInfo: { name: 'workerd-catalog', version: '1.0.0' },
    }),
  ],
});

export default {
  fetch(request: Request): Promise<Response> {
    return catalog(request);
  },
};
