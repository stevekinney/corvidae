import {
  dataElementId,
  dataMediaType,
  type PagePayload,
} from "../data/contract.ts";
import { encodePayload, escapeJson } from "../data/codec.ts";
import type { Transport } from "../data/custom-transport.ts";

type ResponseOptions = {
  signal?: AbortSignal;
  onError?: (error: unknown) => { message: string; [key: string]: unknown };
  transport?: Transport;
};

const encoder = new TextEncoder();
const frame = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
const statusHeaders = (contentType: string) => ({
  "content-type": contentType,
  "cache-control": "private, no-store",
  vary: "Accept",
});

/** Stream initial data and one settlement frame per native pull. */
export function dataResponse(
  payload: PagePayload,
  options: ResponseOptions = {},
): Response {
  const encoded = encodePayload(payload, options);
  const reader = encoded.settlements.getReader();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame({ type: "initial", value: encoded.initial }));
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(frame(result.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(stream, {
    // A successfully decoded protocol message carries its page status in the payload.
    status: 200,
    headers: statusHeaders(`${dataMediaType}; charset=utf-8`),
  });
}

type DocumentOptions = ResponseOptions & {
  payload: PagePayload;
  rendered: { body: string; head: string };
  template?: string;
  registryUrl: string;
};

const attribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** Assemble an HTML document while keeping all data frames inert. */
export function documentResponse(options: DocumentOptions): Response {
  const {
    payload,
    rendered,
    template = "<!doctype html><html><head>%sveltekit.head%</head><body>%sveltekit.body%</body></html>",
    registryUrl,
    signal,
    onError,
    transport,
  } = options;
  const csr = payload.options.csr;
  const encoded = csr
    ? encodePayload(payload, { signal, onError, transport })
    : undefined;
  const styles = payload.stylesheets
    .map((href) => `<link rel="stylesheet" href="${attribute(href)}">`)
    .join("");
  const initial = csr
    ? `<script id="${dataElementId}" type="application/json">${escapeJson(encoded!.initial)}</script>`
    : "";
  const bootstrap = csr
    ? `<script type="module" async>import {start} from ${escapeJson(registryUrl)}; await start({target:document.getElementById("app"),appid:"app"});</script>`
    : "";
  const body = `<div id="app">${rendered.body}</div>${initial}${bootstrap}`;
  const document = template
    .replace("%sveltekit.head%", `${rendered.head}${styles}`)
    .replace("%sveltekit.body%", body);
  if (!csr)
    return new Response(document, {
      status: payload.status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        vary: "Accept",
      },
    });

  const prefix = encoder.encode(document);
  const reader = encoded!.settlements.getReader();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) controller.close();
        else
          controller.enqueue(
            encoder.encode(
              `<script type="application/json" data-velveteen-settlement>${escapeJson(result.value)}</script>`,
            ),
          );
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: payload.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      vary: "Accept",
    },
  });
}
