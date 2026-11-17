/**
 * Test-only builder for Bureau's wire goldens: the three documents `createBureauHandler` serves
 * in each of its two authentication modes, and two JSON-RPC error bodies. Built with no optional
 * mount (`agUi`, `mcp`, `publicUrl` and `mounts` unset) over one Bureau.
 */

import { principalFromApiKey } from '@lostgradient/backchannel';
import { join } from 'node:path';

import { buildBureau } from './bureau-handler-fixtures.test-support.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import {
  formatGoldenJson,
  withGoldenVersion,
  writeGoldenDirectory,
} from './golden-files.test-support.ts';

export const BUREAU_WIRE_GOLDEN_DIRECTORY = join(import.meta.dir, '__fixtures__', 'wire-golden');

const API_KEY = 'golden-key';
const DOCUMENT_PATHS = {
  openapi: '/openapi.json',
  openrpc: '/openrpc.json',
  asyncapi: '/asyncapi.json',
} as const;

type Handler = (request: Request) => Promise<Response>;

async function fetchJson(handler: Handler, request: Request): Promise<Record<string, unknown>> {
  const response = await handler(request);
  return (await response.json()) as Record<string, unknown>;
}

function jsonRpcRequest(method: string, params: unknown, headers: Record<string, string>) {
  return new Request('http://localhost/jsonrpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'golden', method, params }),
  });
}

/** The golden files, keyed by file name. */
export async function buildBureauWireGolden(): Promise<Record<string, string>> {
  const bureau = await buildBureau();
  try {
    const authenticated = createBureauHandler(bureau, {
      authentication: {
        // Keeps the audit line the handler writes by default out of the output.
        auditSink: () => undefined,
        resolveApiKeyPrincipal: async (key) =>
          key === API_KEY
            ? principalFromApiKey({
                subject: 'golden',
                scopes: ['events:read', ...BUREAU_SCOPES],
              })
            : null,
      },
    });
    const local = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });
    const files: Record<string, string> = {};
    for (const [variant, handler, headers] of [
      ['authenticated', authenticated, { 'x-api-key': API_KEY }],
      ['local', local, {}],
    ] as const) {
      for (const [kind, path] of Object.entries(DOCUMENT_PATHS)) {
        const document = await fetchJson(
          handler,
          new Request(`http://localhost${path}`, { headers }),
        );
        files[`${variant}.${kind}.json`] = formatGoldenJson(withGoldenVersion(document));
      }
    }
    files['error-method-not-found.json'] = formatGoldenJson(
      await fetchJson(local, jsonRpcRequest('bureau.does.not.exist', undefined, {})),
    );
    files['error-invalid-params.json'] = formatGoldenJson(
      await fetchJson(local, jsonRpcRequest('bureau.tasks.get', {}, {})),
    );
    return files;
  } finally {
    await bureau.dispose();
  }
}

/** Rewrite a directory to hold exactly the Bureau wire goldens. */
export async function writeBureauWireGolden(directory: string): Promise<void> {
  await writeGoldenDirectory(directory, await buildBureauWireGolden());
}
