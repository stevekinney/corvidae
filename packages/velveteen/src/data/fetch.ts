import type { Fetch, FetchRecord } from "./contract.ts";

/** Preserve Request bodies/methods while resolving strings relative to the load's URL. */
export function loadRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  baseURL: string,
  signal?: AbortSignal,
): Request {
  const policies = [
    "credentials",
    "cache",
    "mode",
    "redirect",
    "referrer",
    "referrerPolicy",
    "integrity",
    "keepalive",
  ] as const;
  const source = input instanceof Request ? input : undefined;
  const request = new Request(
    input instanceof Request ? input : new URL(String(input), baseURL),
    signal
      ? {
          ...init,
          signal: AbortSignal.any([
            init?.signal ?? source?.signal ?? new AbortController().signal,
            signal,
          ]),
        }
      : init,
  );
  // Bun 1.4.4 currently normalizes some Request policy fields; retain explicit
  // caller intent on the request object so replay keys remain exact.
  for (const field of policies) {
    const value =
      init?.[field] ??
      source?.[field] ??
      (!source
        ? (
            {
              credentials: "same-origin",
              cache: "default",
              mode: "cors",
              redirect: "follow",
              referrer: "about:client",
              referrerPolicy: "",
              integrity: "",
              keepalive: false,
            } as const
          )[field]
        : undefined);
    if (value !== undefined) Object.defineProperty(request, field, { value });
  }
  return request;
}
/** Cache keys hash explicit request headers and bytes, never serialize credential values. */
export async function fetchKey(
  request: Request,
  url = request.url,
): Promise<string> {
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? new Uint8Array()
      : new Uint8Array(await request.clone().arrayBuffer());
  const metadata = new TextEncoder().encode(
    JSON.stringify([
      request.method,
      url,
      request.credentials,
      request.cache,
      request.mode,
      request.redirect,
      request.referrer,
      request.referrerPolicy,
      request.integrity,
      request.keepalive,
      Array.from(request.headers).toSorted(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ]),
  );
  const input = new Uint8Array(metadata.length + body.length);
  input.set(metadata);
  input.set(body, metadata.length);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
/** Capture only responses actually consumed by universal SSR loads; headers require explicit opt-in. */
export function createCapturedFetch(
  network: Fetch,
  baseURL: string,
  records: FetchRecord[],
  options: {
    signal?: AbortSignal;
    filterHeader?: (name: string, value: string) => boolean;
  } = {},
): Fetch {
  return async (input, init) => {
    const request = loadRequest(input, init, baseURL, options.signal);
    const key = await fetchKey(request);
    const response = await network(request);
    let captured: Promise<void> | undefined;
    const capture = () =>
      (captured ??= (async () => {
        const body = new Uint8Array(await response.clone().arrayBuffer());
        records.push({
          key,
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers].filter(
            ([name, value]) =>
              name !== "set-cookie" &&
              name !== "authorization" &&
              name !== "cookie" &&
              options.filterHeader?.(name, value),
          ),
          body,
        });
      })());
    let bodyCaptured = false;
    let bodyForConsumer: ReadableStream<Uint8Array> | null = null;
    let consumerResponse: Response | null = null;
    const captureBody = () => {
      if (bodyCaptured || !response.body) return;
      bodyCaptured = true;
      const chunks: Uint8Array[] = [];
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          chunks.push(chunk.slice());
          controller.enqueue(chunk);
        },
        flush() {
          const body = new Uint8Array(
            chunks.reduce((size, chunk) => size + chunk.length, 0),
          );
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.length;
          }
          records.push({
            key,
            status: response.status,
            statusText: response.statusText,
            headers: [...response.headers].filter(
              ([name, value]) =>
                name !== "set-cookie" &&
                name !== "authorization" &&
                name !== "cookie" &&
                options.filterHeader?.(name, value),
            ),
            body,
          });
        },
      });
      bodyForConsumer = response.body.pipeThrough(transform);
      consumerResponse = new Response(bodyForConsumer, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    return new Proxy(response, {
      get(target, property) {
        if (property === "body") {
          captureBody();
          return consumerResponse?.body ?? bodyForConsumer;
        }
        if (property === "clone") {
          return () => {
            captureBody();
            return consumerResponse?.clone() ?? target.clone();
          };
        }
        const value = Reflect.get(target, property, target);
        if (
          ["text", "json", "arrayBuffer", "blob", "formData"].includes(
            String(property),
          )
        )
          return async (...args: unknown[]) =>
            bodyCaptured
              ? Reflect.apply(value, consumerResponse, args)
              : (await capture(), Reflect.apply(value, target, args));
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}
/** Hydration consumes captured responses; navigation uses ordinary enhanced fetch with abort propagation. */
export function createReplayFetch(
  records: FetchRecord[],
  baseURL: string,
  network: Fetch,
  signal?: AbortSignal,
  capturedBaseURL?: string,
): Fetch {
  const available = [...records];
  return async (input, init) => {
    const request = loadRequest(input, init, baseURL, signal);
    const url = new URL(request.url);
    if (capturedBaseURL && url.origin === new URL(baseURL).origin) {
      const captured = new URL(capturedBaseURL);
      url.protocol = captured.protocol;
      url.host = captured.host;
    }
    const key = await fetchKey(request, url.href);
    const index = available.findIndex((record) => record.key === key);
    if (index < 0) return network(request);
    request.signal.throwIfAborted();
    const record = available.splice(index, 1)[0];
    return new Response(
      [204, 205, 304].includes(record.status) ? null : record.body.slice(),
      {
        status: record.status,
        statusText: record.statusText,
        headers: record.headers,
      },
    );
  };
}
