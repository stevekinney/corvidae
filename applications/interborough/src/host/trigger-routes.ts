/**
 * `POST /triggers/<workflow-id>` (COR-2169): how an external sender, a webhook, starts work in a
 * workflow file whose trigger kind defines `receive` (COR-2168).
 *
 * It is the one route a public origin reaches with no credential and no session, so it does
 * almost nothing itself:
 *
 * - **Authentication** is the trigger's. The route reads the body as bytes, builds a fresh request
 *   from them, and hands it to `bureau.workflows.receiveTrigger(id, request)`; the kind's `receive`
 *   checks the sender (`verifyHmacSignature` in the plugin package) and calls `fire`. The route
 *   passes no principal, so a run it starts takes the workspace authority Bureau captures for the
 *   deployment's owner of record (`workflow-runtime.ts`, `triggerAuthority`).
 * - **Admission** is the policy's: `POST /triggers/:workflow` is `deployment-operator` with the
 *   `trigger-receive` admission, which skips `authorize` and `release` and is checked by the
 *   public-origin guard (`host-route-policy.ts`, `request-guard.ts`).
 * - **The body** is capped at {@link MAXIMUM_TRIGGER_BODY_BYTES}. A `Content-Length` over it is
 *   answered 413 without reading a byte; a body that declares less, or nothing, is counted as it
 *   streams, and the 413 is answered the moment the count would pass the cap, with nothing past
 *   the cap kept.
 * - **The answer** is Bureau's or the trigger's, passed through unchanged (its 404 for an id that
 *   is not an applied file, its 405 for a file whose trigger does not receive, and whatever
 *   `Response` `receive` resolved). Every answer the route authors, 413, 500 and 503, has no body.
 *   503 is for a Bureau without workflows and for a plugin that needs setup; any other rejection is
 *   500. Neither says why: the log line holds the workflow id and the error's `name`, as JSON,
 *   and never its message, which a plugin may have written a secret into.
 *
 * @module trigger-routes
 */
import type { BureauWorkflows } from '@lostgradient/bureau';

/** The route a trigger delivery is registered at. The identifier is Bun's decoded parameter. */
export const TRIGGER_ROUTE = '/triggers/:workflow';

/** The largest body, in bytes, the route accepts: 4 MiB. It is the route's own, not Weft's WebSocket cap. */
export const MAXIMUM_TRIGGER_BODY_BYTES = 4 * 1024 * 1024;

/** The part of the Bureau the route calls. */
export interface TriggerBureau {
  /** The workflow runtime, or `undefined` when this Bureau runs no workflows. */
  readonly workflows: Pick<BureauWorkflows, 'receiveTrigger'> | undefined;
}

/** What the route needs from the host. */
export interface TriggerRouteDependencies {
  /** The Bureau a delivery is handed to. */
  readonly bureau: TriggerBureau;
  /**
   * Where a 500 or 503 is reported: the workflow id and the error's name, as one JSON line. The
   * host's `warn` option, which defaults to `console.warn`.
   */
  readonly warn?: ((message: string) => void) | undefined;
}

/** An answer the route authors: a status and nothing else. */
function statusResponse(status: 413 | 500 | 503): Response {
  return new Response(null, { status });
}

/** The declared length, when `Content-Length` is a whole number; a header that is not one declares nothing. */
function declaredLength(request: Request): number | undefined {
  const header = request.headers.get('content-length')?.trim();
  return header !== undefined && /^\d{1,16}$/.test(header) ? Number(header) : undefined;
}

/**
 * The body's bytes, or `'too-large'` once they would pass `maximum`. A declared length over it
 * answers before the stream is touched; otherwise each chunk is counted before it is kept, so
 * nothing past the cap is buffered, and the stream is cancelled when the cap is crossed.
 */
async function readBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer> | 'too-large'> {
  const declared = declaredLength(request);
  if (declared !== undefined && declared > maximum) {
    // Best effort: nothing waits on the cancellation, and nothing is read.
    void request.body?.cancel().catch(() => undefined);
    return 'too-large';
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maximum) {
      await reader.cancel().catch(() => undefined);
      return 'too-large';
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The status of a rejection of `receiveTrigger`: 503 for a plugin that needs setup (it declares a
 * secret it has not been given, and its error carries that name), 500 for anything else.
 */
function statusOf(error: unknown): 500 | 503 {
  return error instanceof Error && error.name === 'PluginNeedsSetupError' ? 503 : 500;
}

/** The name a failure is reported under: an error's own, never its message. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The Bun route of a trigger delivery. */
export function triggerRoutes(dependencies: TriggerRouteDependencies) {
  const { bureau } = dependencies;
  const warn = dependencies.warn ?? ((message: string) => console.warn(message));
  const report = (workflow: string, error: string): void =>
    warn(JSON.stringify({ event: 'host.trigger.failure', workflow, error }));
  return {
    [TRIGGER_ROUTE]: {
      POST: async (request: Bun.BunRequest<typeof TRIGGER_ROUTE>): Promise<Response> => {
        // The host owns `request`: take what the fresh one needs before anything awaits.
        const { workflow } = request.params;
        const { method, url, signal: incoming } = request;
        const headers = new Headers(request.headers);
        const workflows = bureau.workflows;
        if (workflows === undefined) {
          report(workflow, 'WorkflowsUnavailable');
          return statusResponse(503);
        }
        try {
          const bytes = await readBody(request, MAXIMUM_TRIGGER_BODY_BYTES);
          if (bytes === 'too-large') return statusResponse(413);
          // A fresh request over the bytes that were read, so `receive` reads them as often as it
          // likes and the incoming stream is never shared. Its signal follows the incoming one
          // only until `receiveTrigger` settles: the host may abort the incoming request once its
          // response is sent, and that must not stop a `fire` an acknowledged delivery makes later.
          const controller = new AbortController();
          const follow = (): void => controller.abort(incoming.reason);
          if (incoming.aborted) follow();
          else incoming.addEventListener('abort', follow, { once: true });
          try {
            return await workflows.receiveTrigger(
              workflow,
              new Request(url, { method, headers, body: bytes, signal: controller.signal }),
            );
          } finally {
            incoming.removeEventListener('abort', follow);
          }
        } catch (error) {
          report(workflow, nameOf(error));
          return statusResponse(statusOf(error));
        }
      },
    },
  };
}
