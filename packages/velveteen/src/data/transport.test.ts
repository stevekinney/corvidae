import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { encodePayload } from "./codec.ts";
import { readDataResponse } from "./transport.ts";
import { dataMediaType, type PagePayload } from "./contract.ts";

const response = (body: ReadableStream<Uint8Array>) =>
  new Response(body, {
    headers: { "content-type": `${dataMediaType}; charset=utf-8` },
  });
const page = (value: unknown): PagePayload => ({
  version: 1,
  url: "https://example.test/",
  basePath: "",
  stylesheets: [],
  routeId: "/",
  params: {},
  status: 200,
  error: null,
  options: { ssr: true, csr: true },
  nodes: [],
  branch: [],
  fetched: [],
  ...(value ? { extra: value } : {}),
});

test("cancels the native reader for malformed initial data", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("not-json\n"));
    },
    cancel() {
      canceled = true;
    },
  });
  expect(await throwingRejectionOf(readDataResponse(response(body)))).toThrow();
  expect(canceled).toBe(true);
});

test("cancels and rejects completion for malformed later frames", async () => {
  const encoded = encodePayload(page({ ready: true }));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          JSON.stringify({ type: "initial", value: encoded.initial }) + "\n",
        ),
      );
      controller.enqueue(encoder.encode("not-json\n"));
    },
    cancel() {
      /* cancellation is asserted by the rejected done promise */
    },
  });
  const read = await readDataResponse(response(body));
  expect(await throwingRejectionOf(read.done)).toThrow();
});

test("aborts before the first frame and cancels the reader", async () => {
  const controller = new AbortController();
  controller.abort(new Error("before first frame"));
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  expect(
    await throwingRejectionOf(
      readDataResponse(response(body), controller.signal),
    ),
  ).toThrow("before first frame");
  expect(canceled).toBe(true);
});

test("truncated unresolved values reject both done and the deferred value", async () => {
  const pending = Promise.withResolvers<string>();
  const encoded = encodePayload(page({ pending: pending.promise }));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          JSON.stringify({ type: "initial", value: encoded.initial }) + "\n",
        ),
      );
      controller.close();
    },
  });
  const read = await readDataResponse(response(body));
  expect(await throwingRejectionOf(read.done)).toThrow("truncated");
  expect(
    await throwingRejectionOf(
      (read.payload as unknown as { extra: { pending: Promise<string> } }).extra
        .pending,
    ),
  ).toThrow("truncated");
});
