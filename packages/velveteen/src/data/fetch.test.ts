import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { test, expect } from "bun:test";
import {
  createCapturedFetch,
  createReplayFetch,
  fetchKey,
  loadRequest,
} from "./fetch.ts";
import type { FetchRecord } from "./contract.ts";
test("EF01: captured fetches replay exact consumed bodies without serializing credentials", async () => {
  const records: FetchRecord[] = [];
  let count = 0;
  const capture = createCapturedFetch(
    async (request) => {
      expect((request as Request).method).toBe("POST");
      expect(await (request as Request).text()).toBe("body");
      count++;
      return new Response("answer", {
        headers: {
          "set-cookie": "private",
          "x-safe": "yes",
          "x-secret": "hidden",
        },
      });
    },
    "https://app.test/",
    records,
    { filterHeader: (name) => name === "x-safe" },
  );
  const request = new Request("https://app.test/api", {
    method: "POST",
    body: "body",
    headers: { authorization: "PRIVATE_TOKEN" },
  });
  const fetchedResponse = await capture(request.clone());
  expect(await fetchedResponse.text()).toBe("answer");
  expect(records).toHaveLength(1);
  expect(JSON.stringify(records)).not.toContain("PRIVATE_TOKEN");
  expect(records[0].headers).toEqual([["x-safe", "yes"]]);
  const replay = createReplayFetch(records, "https://app.test/", async () => {
    count++;
    throw new Error("Unexpected hydration network");
  });
  const fetchedResponse2 = await replay(request.clone());
  expect(await fetchedResponse2.text()).toBe("answer");
  expect(count).toBe(1);
  expect(
    loadRequest("../api", undefined, "https://app.test/nested/page").url,
  ).toBe("https://app.test/api");
});

test("captured bytes replay without another network request", async () => {
  const records: FetchRecord[] = [];
  let count = 0;
  const capture = createCapturedFetch(
    async () => {
      count++;
      return new Response(new Uint8Array([0, 1, 2, 255]));
    },
    "https://app.test/",
    records,
  );
  const capturedResponse = await capture("/bytes");
  expect([...(await capturedResponse.bytes())]).toEqual([0, 1, 2, 255]);
  const replay = createReplayFetch(records, "https://app.test/", async () => {
    count++;
    throw new Error("Unexpected hydration network");
  });
  const replayedResponse = await replay("/bytes");
  expect([...(await replayedResponse.bytes())]).toEqual([0, 1, 2, 255]);
  expect(count).toBe(1);
});

test("fetchKey distinguishes request credential and replay policy", async () => {
  const input = loadRequest(
    "/resource",
    { credentials: "omit" },
    "https://app.test/",
  );
  const same = loadRequest(
    "/resource",
    { credentials: "omit" },
    "https://app.test/",
  );
  const different = loadRequest(
    "/resource",
    { credentials: "include" },
    "https://app.test/",
  );
  expect(await fetchKey(input)).toBe(await fetchKey(same));
  expect(await fetchKey(input)).not.toBe(await fetchKey(different));
});

test("preserves credentials omit when merging an abort signal and cloning", async () => {
  const controller = new AbortController();
  const request = loadRequest(
    "/resource",
    { credentials: "omit", method: "POST", body: "body" },
    "https://app.test/",
    controller.signal,
  );
  expect(request.credentials).toBe("omit");
  expect(request.signal).not.toBe(controller.signal);
  const clone = loadRequest(request, undefined, "https://app.test/");
  expect(clone.credentials).toBe("omit");
  expect(await clone.text()).toBe("body");
});

test("captured fetch records bodies consumed through the native stream and supports clones", async () => {
  const records: FetchRecord[] = [];
  const capture = createCapturedFetch(
    async () => new Response("streamed", { headers: { "x-safe": "yes" } }),
    "https://app.test/",
    records,
    { filterHeader: (name) => name === "x-safe" },
  );
  const response = await capture("/stream");
  const clone = response.clone();
  expect(await clone.text()).toBe("streamed");
  const reader = response.body!.getReader();
  for (
    let chunk = await reader.read();
    !chunk.done;
    chunk = await reader.read()
  ) {
    /* Consume through EOF before inspecting captured data. */
  }
  expect(records).toHaveLength(1);
  expect(new TextDecoder().decode(records[0].body)).toBe("streamed");
});

test("records asynchronous body chunks before the consumer observes EOF", async () => {
  const records: FetchRecord[] = [];
  const capture = createCapturedFetch(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            await new Promise((resolve) => setTimeout(resolve, 5));
            controller.enqueue(new TextEncoder().encode("second"));
            controller.close();
          },
        }),
      ),
    "https://app.test/",
    records,
  );
  const response = await capture("/chunks");
  const reader = response.body!.getReader();
  for (
    let chunk = await reader.read();
    !chunk.done;
    chunk = await reader.read()
  ) {
    /* Consume through EOF before inspecting captured data. */
  }
  expect(records).toHaveLength(1);
  expect(new TextDecoder().decode(records[0].body)).toBe("firstsecond");
});

test("does not record partial bodies after a producer failure or cancellation", async () => {
  const records: FetchRecord[] = [];
  const capture = createCapturedFetch(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.error(new Error("body failed"));
          },
        }),
      ),
    "https://app.test/",
    records,
  );
  const response = await capture("/failed");
  const reader = response.body!.getReader();
  await reader.read();
  expect(await throwingRejectionOf(reader.read())).toThrow("body failed");
  expect(records).toHaveLength(0);
});

test("EF01: explicit caller abort and browser defaults survive RequestInit and framework signals", () => {
  const user = new AbortController(),
    framework = new AbortController();
  const request = loadRequest(
    "/resource",
    { headers: { "x-test": "value" }, signal: user.signal },
    "https://app.test/",
    framework.signal,
  );
  expect(request.credentials).toBe("same-origin");
  expect(request.referrer).toBe("about:client");
  expect(request.keepalive).toBe(false);
  user.abort(new Error("Caller canceled"));
  expect(request.signal.aborted).toBe(true);
  expect(request.signal.reason.message).toBe("Caller canceled");
});

test("H03: relocated prerender hydration replays captured same-origin fetches and sends misses to the deployment origin", async () => {
  const records: FetchRecord[] = [];
  const captured = createCapturedFetch(
    async () => new Response("captured"),
    "http://build.invalid/app/",
    records,
  );
  const fetchedResponse3 = await captured("/app/api");
  expect(await fetchedResponse3.text()).toBe("captured");
  const sent: string[] = [];
  const replay = createReplayFetch(
    records,
    "https://deployed.test/app/",
    async (input) => {
      sent.push(input instanceof Request ? input.url : String(input));
      return new Response("network");
    },
    undefined,
    "http://build.invalid/app/",
  );
  const fetchedResponse4 = await replay("/app/api");
  expect(await fetchedResponse4.text()).toBe("captured");
  expect(sent).toEqual([]);
  const fetchedResponse5 = await replay("/app/missing");
  expect(await fetchedResponse5.text()).toBe("network");
  expect(sent).toEqual(["https://deployed.test/app/missing"]);
});
