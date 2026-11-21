import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { encodePayload, createDecoder, escapeJson } from "./codec.ts";

test("EF01: rich values, repeated references and cycles survive the shared codec", () => {
  const repeated = { message: "</script><script>attack()</script>" };
  const value: Record<string, unknown> = {
    repeated,
    again: repeated,
    date: new Date("2026-01-01"),
    url: new URL("https://example.test/path"),
    map: new Map([["key", 1]]),
    set: new Set([2]),
    big: 3n,
    undefined: undefined,
    regexp: /test/gi,
    bytes: new Uint8Array([1, 2]),
  };
  value.self = value;
  const encoded = encodePayload(value);
  const decoded = createDecoder(encoded.initial).value as typeof value;
  expect(decoded.self).toBe(decoded);
  expect(decoded.again).toBe(decoded.repeated);
  expect(decoded.date).toEqual(value.date);
  expect(decoded.map).toEqual(value.map);
  expect(decoded.set).toEqual(value.set);
  expect(decoded.big).toBe(3n);
  expect(decoded.url).toEqual(value.url);
  expect(decoded.bytes).toEqual(value.bytes);
  expect(escapeJson(encoded.initial)).not.toContain("</script");
  expect(() => encodePayload({ callback: () => {} })).toThrow();
});

test("EF01: deferred values stream without awaiting the initial payload and reject explicitly", async () => {
  const first = Promise.withResolvers<string>();
  const failure = Promise.withResolvers<string>();
  const encoded = encodePayload({
    first: first.promise,
    again: first.promise,
    failure: failure.promise,
  });
  const decoder = createDecoder(encoded.initial);
  const value = decoder.value as {
    first: Promise<string>;
    again: Promise<string>;
    failure: Promise<string>;
  };
  expect(value.first).toBe(value.again);
  const reader = encoded.settlements.getReader();
  first.resolve("resolved");
  failure.reject(new Error("PRIVATE_IMPLEMENTATION"));
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    decoder.accept(result.value);
  }
  decoder.finish();
  expect(await value.first).toBe("resolved");
  expect(await throwingRejectionOf(value.failure)).toThrow("Internal Error");
});

test("preserves a promise reference that reappears in a later settlement", async () => {
  const deferred = Promise.withResolvers<Record<string, unknown>>();
  const encoded = encodePayload({ value: deferred.promise });
  const decoder = createDecoder(encoded.initial);
  const reader = encoded.settlements.getReader();
  deferred.resolve({ again: deferred.promise });
  const frame = await reader.read();
  decoder.accept(frame.value);
  const value = decoder.value as { value: Promise<{ again: unknown }> };
  const resolved = await value.value;
  expect(resolved.again).toBe(value.value);
  expect(() => decoder.accept(frame.value)).toThrow(
    "Invalid promise settlement",
  );
  await reader.cancel();
});

test("falls back when the error sanitizer itself throws", async () => {
  const deferred = Promise.withResolvers<never>();
  const encoded = encodePayload(
    { value: deferred.promise },
    {
      onError: () => {
        throw new Error("sanitizer failed");
      },
    },
  );
  const reader = encoded.settlements.getReader();
  deferred.reject(new Error("private"));
  const result = await reader.read();
  expect((result.value as { error: { message: string } }).error).toEqual({
    message: "Internal Error",
  });
  await reader.cancel();
});

test("EF01: truncation, malformed frames and cancellation fail unresolved values", async () => {
  const pending = Promise.withResolvers();
  const controller = new AbortController();
  const encoded = encodePayload(
    { pending: pending.promise },
    { signal: controller.signal },
  );
  const decoder = createDecoder(encoded.initial);
  expect(() =>
    decoder.accept({ type: "resolve", id: 999, value: "[]" }),
  ).toThrow();
  const value = decoder.value as { pending: Promise<unknown> };
  expect(() => decoder.finish()).toThrow("truncated");
  expect(await throwingRejectionOf(value.pending)).toThrow("truncated");
  controller.abort(new Error("cancelled"));
  expect(
    await throwingRejectionOf(encoded.settlements.getReader().read()),
  ).toThrow("cancelled");
});
