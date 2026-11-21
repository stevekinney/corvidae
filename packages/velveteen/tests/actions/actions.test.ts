import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { fail, runAction } from "../../src/actions/server.ts";
import {
  defineRemoteForm,
  remoteFormAction,
  runRemoteForm,
} from "../../src/remote/forms.ts";
import type { RequestEvent } from "../../src/server/types.ts";

function eventFor(request: Request): RequestEvent {
  return {
    request,
    url: new URL(request.url),
    params: {},
    route: { id: "/" },
    locals: {},
    cookies: { get: () => undefined, getAll: () => [], set() {}, delete() {} },
    platform: undefined,
    fetch: globalThis.fetch,
    setHeaders() {},
    getClientAddress: () => "127.0.0.1",
    signal: new AbortController().signal,
  };
}

function formRequest(url: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request(url, { method: "POST", body: form });
}

test("runs default and named actions with native FormData", async () => {
  const seen: string[] = [];
  const actions = {
    default: async ({ request }: RequestEvent) => {
      seen.push((await request.formData()).get("value") as string);
      return { ok: true };
    },
  };
  expect(
    await runAction(
      actions,
      eventFor(formRequest("http://app.test/", { value: "one" })),
    ),
  ).toMatchObject({
    type: "success",
    status: 200,
    data: { ok: true },
  });
  expect(seen).toEqual(["one"]);

  const named = { save: () => ({ saved: true }) };
  expect(
    await runAction(named, eventFor(formRequest("http://app.test/?/save", {}))),
  ).toMatchObject({
    type: "success",
    data: { saved: true },
  });
});

test("rejects invalid action exports, media types and named/default collisions", async () => {
  const request = formRequest("http://app.test/", {});
  expect(
    await throwingRejectionOf(
      runAction({ default: () => null, other: () => null }, eventFor(request)),
    ),
  ).toThrow("Actions cannot export both");
  expect(
    await throwingRejectionOf(
      runAction(
        { default: () => null },
        eventFor(new Request(request.url, { method: "POST", body: "x" })),
      ),
    ),
  ).toThrow("Unsupported Media Type");
  expect(
    await runAction(
      { save: () => fail(422, { field: "bad" }) },
      eventFor(formRequest("http://app.test/?/save", {})),
    ),
  ).toMatchObject({
    type: "failure",
    status: 422,
    data: { field: "bad" },
  });
});

test("requires valid native form data and the private failure brand", async () => {
  expect(
    await throwingRejectionOf(
      runAction(
        { default: () => undefined },
        eventFor(
          new Request("http://app.test/", {
            method: "POST",
            headers: { "content-type": "multipart/form-data; boundary=bad" },
            body: "broken",
          }),
        ),
      ),
    ),
  ).toThrow("Bad Request");
  expect(
    await runAction(
      {
        default: () => ({ type: "failure", status: 422, data: { fake: true } }),
      },
      eventFor(formRequest("http://app.test/", {})),
    ),
  ).toMatchObject({ type: "success" });
  expect(
    await throwingRejectionOf(
      runAction(
        { default: () => [] },
        eventFor(formRequest("http://app.test/", {})),
      ),
    ),
  ).toThrow("plain data object");
});

test("runs dedicated remote forms and preserves the ordinary query", async () => {
  expect(remoteFormAction("/checkout?from=cart", "save")).toBe(
    "/checkout?from=cart&/remote=save",
  );
  const seen: string[] = [];
  const forms = {
    save: defineRemoteForm({
      validate: (data) => ({
        value: String(data.get("value")),
        file: data.get("file"),
      }),
      handle: ({ value, file }: { value: string; file: unknown }, event) => {
        seen.push(`${value}:${file instanceof File ? file.name : "none"}`);
        return { saved: value, cookie: event.cookies.get("session") ?? "none" };
      },
    }),
  };
  const data = new FormData();
  data.set("value", "one");
  data.set("file", new File(["contents"], "note.txt"));
  expect(
    await runRemoteForm(
      forms,
      eventFor(
        new Request("http://app.test/checkout?from=cart&/remote=save", {
          method: "POST",
          body: data,
        }),
      ),
    ),
  ).toMatchObject({ type: "success", data: { saved: "one" } });
  expect(seen).toEqual(["one:note.txt"]);
});

test("rejects unknown and duplicate remote form selectors before validation", async () => {
  let called = 0;
  const forms = {
    save: defineRemoteForm({
      validate: () => {
        called++;
        return {};
      },
      handle: () => ({ ok: true }),
    }),
  };
  expect(
    await throwingRejectionOf(
      runRemoteForm(
        forms,
        eventFor(formRequest("http://app.test/?/remote=missing", {})),
      ),
    ),
  ).toThrow("Not Found");
  expect(
    await throwingRejectionOf(
      runRemoteForm(
        forms,
        eventFor(formRequest("http://app.test/?/remote=save&/remote=save", {})),
      ),
    ),
  ).toThrow("Invalid remote form selector");
  expect(called).toBe(0);
});

test("only branded remote form validation failures skip the handler", async () => {
  const forms = {
    save: defineRemoteForm<{ type: "failure"; value: string }>({
      validate: (data) =>
        data.has("value")
          ? { type: "failure", value: String(data.get("value")) }
          : fail(422, { issue: "Value required" }),
      handle: ({ value }) => ({ value }),
    }),
  };
  const address = "http://app.test/?/remote=save";
  expect(
    await runRemoteForm(forms, eventFor(formRequest(address, {}))),
  ).toMatchObject({
    type: "failure",
    status: 422,
    data: { issue: "Value required" },
  });
  expect(
    await runRemoteForm(
      forms,
      eventFor(formRequest(address, { value: "retained" })),
    ),
  ).toMatchObject({
    type: "success",
    data: { value: "retained" },
  });
  const action = remoteFormAction("/checkout?from=cart&/remote=old", "save");
  expect(action).toBe("/checkout?from=cart&/remote=save");
  expect(() => remoteFormAction("https://example.test//other", "save")).toThrow(
    "Ambiguous remote form path",
  );
});
