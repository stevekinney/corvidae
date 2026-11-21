import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import type { PagePayload } from "../data/contract.ts";
import { dataResponse, documentResponse } from "./responses.ts";

const payload = (value: unknown, csr = true): PagePayload => ({
  version: 1,
  url: "https://example.test/",
  basePath: "",
  stylesheets: ["/assets/main.css?x=1&y=2"],
  routeId: "/",
  params: {},
  status: 200,
  error: null,
  options: { ssr: true, csr },
  nodes: [
    {
      key: "0:page",
      node: 0,
      role: "page",
      data: { value },
      uses: {
        params: [],
        search: [],
        url: [],
        dependencies: [],
        parent: false,
        route: false,
      },
    },
  ],
  branch: [{ node: 0, role: "page" }],
  fetched: [],
});

test("dataResponse streams initial and deferred settlement frames", async () => {
  const deferred = Promise.withResolvers<string>();
  const response = dataResponse(payload({ deferred: deferred.promise }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Accept");
  const reader = response.body!.getReader();
  const initial = await reader.read();
  expect(new TextDecoder().decode(initial.value)).toContain('"type":"initial"');
  deferred.resolve("settled");
  const settlement = await reader.read();
  expect(new TextDecoder().decode(settlement.value)).toContain(
    '"type":"resolve"',
  );
  await reader.cancel();
});

test("rejected deferred values use the public error frame", async () => {
  const deferred = Promise.withResolvers<never>();
  const response = dataResponse(payload({ deferred: deferred.promise }), {
    onError: () => ({ message: "safe failure" }),
  });
  const reader = response.body!.getReader();
  await reader.read();
  deferred.reject(new Error("secret implementation detail"));
  const readResult = await reader.read();
  const frame = new TextDecoder().decode(readResult.value);
  expect(frame).toContain("safe failure");
  expect(frame).not.toContain("secret implementation detail");
  await reader.cancel();
});

test("canceling a data body cancels the settlement reader", async () => {
  const deferred = Promise.withResolvers<string>();
  const response = dataResponse(payload({ deferred: deferred.promise }));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel("navigation superseded");
  const readResult2 = await reader.read();
  expect(readResult2.done).toBe(true);
  deferred.resolve("never serialized");
});

test("aborting the response signal rejects a pending settlement read", async () => {
  const controller = new AbortController();
  const deferred = Promise.withResolvers<string>();
  const response = dataResponse(payload({ deferred: deferred.promise }), {
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  const pending = reader.read();
  controller.abort(new Error("request canceled"));
  expect(await throwingRejectionOf(pending)).toThrow("request canceled");
  deferred.resolve("never serialized");
});

test("documentResponse escapes script data and streams inert settlements", async () => {
  const deferred = Promise.withResolvers<string>();
  const response = documentResponse({
    payload: payload({
      html: "</script><script>bad()</script>",
      deferred: deferred.promise,
    }),
    rendered: { body: "<h1>Hello</h1>", head: "<title>Hello</title>" },
    registryUrl: "/_assets/client.js?x=1&y=2",
  });
  const reader = response.body!.getReader();
  const readResult3 = await reader.read();
  const initial = new TextDecoder().decode(readResult3.value);
  expect(initial).toContain("velveteen-data");
  expect(initial).not.toContain("</script><script>bad()");
  expect(initial).not.toContain("data-velveteen-settlement");
  deferred.resolve("done");
  const readResult4 = await reader.read();
  const settlement = new TextDecoder().decode(readResult4.value);
  expect(settlement).toContain("data-velveteen-settlement");
  await reader.cancel();
});

test("csr false omits bootstrap and data scripts", async () => {
  const response = documentResponse({
    payload: payload({ ready: true }, false),
    rendered: { body: "<p>ready</p>", head: "" },
    registryUrl: "/client.js",
  });
  const text = await response.text();
  expect(text).toContain("ready");
  expect(text).not.toContain("velveteen-data");
  expect(text).not.toContain('type="module"');
});

test("data protocol carries page error status without a failing browser transport status", async () => {
  const value = payload({});
  value.status = 418;
  value.error = { message: "Teapot" };
  const response = dataResponse(value);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain("418");
  expect(text).toContain("Teapot");
});
