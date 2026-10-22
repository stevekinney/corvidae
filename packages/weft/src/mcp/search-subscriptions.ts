import { readRequestBody } from '@modelcontextprotocol/server';

import { isWorkflowSearchResourceUri } from './resources.ts';

/**
 * The workflow-search resources that open `subscriptions/listen` streams on
 * the HTTP endpoint asked to hear about.
 *
 * The SDK's listen router delivers `notifications/resources/updated` only for
 * the exact URI a change names, and a workflow change does not name the
 * searches whose results it may change. So the endpoint reads each listen
 * request's `notifications.resourceSubscriptions` on the way in, keeps its
 * search URIs for as long as the stream stays open, and publishes an update
 * for every one of them whenever a workflow changes.
 */
export class SearchSubscriptions {
  readonly #counts = new Map<string, number>();

  /** The search URIs at least one open stream subscribed to. */
  uris(): ReadonlyArray<string> {
    return [...this.#counts.keys()];
  }

  /**
   * Serve one request, tracking the search URIs of a `subscriptions/listen`
   * request until its response stream ends.
   */
  async serve(
    request: Request,
    maxBodyBytes: number,
    respond: () => Promise<Response>,
  ): Promise<Response> {
    const uris = await listenSearchUris(request, maxBodyBytes);
    if (uris.length === 0) return respond();
    for (const uri of uris) this.#counts.set(uri, (this.#counts.get(uri) ?? 0) + 1);
    const release = () => {
      for (const uri of uris) {
        const count = (this.#counts.get(uri) ?? 1) - 1;
        if (count === 0) this.#counts.delete(uri);
        else this.#counts.set(uri, count);
      }
    };
    try {
      return releaseWhenBodyEnds(await respond(), release);
    } catch (error) {
      release();
      throw error;
    }
  }
}

/**
 * The search URIs a 2026-07-28 `subscriptions/listen` request names. Modern
 * clients send the method in the `Mcp-Method` header, which the SDK checks
 * against the body, so other requests are never read here.
 */
async function listenSearchUris(request: Request, maxBodyBytes: number): Promise<string[]> {
  if (request.method !== 'POST') return [];
  if (request.headers.get('mcp-method') !== 'subscriptions/listen') return [];
  const body = await readRequestBody(request.clone(), maxBodyBytes).catch(() => undefined);
  if (body === undefined || body.tooLarge) return [];
  let message: unknown;
  try {
    message = JSON.parse(body.text);
  } catch {
    return [];
  }
  const subscriptions = (
    message as { params?: { notifications?: { resourceSubscriptions?: unknown } } } | null
  )?.params?.notifications?.resourceSubscriptions;
  if (!Array.isArray(subscriptions)) return [];
  return [
    ...new Set(
      subscriptions.filter(
        (uri): uri is string => typeof uri === 'string' && isWorkflowSearchResourceUri(uri),
      ),
    ),
  ];
}

/** Call `release` once the response body finishes, fails, or is cancelled. */
function releaseWhenBodyEnds(response: Response, release: () => void): Response {
  const source = response.body;
  if (source === null) {
    release();
    return response;
  }
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          releaseOnce();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        releaseOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      releaseOnce();
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
