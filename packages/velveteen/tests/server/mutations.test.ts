import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify, parse } from "devalue";
import { buildProduction } from "../../src/build/index.ts";
import {
  createApplication,
  getRequestEvent,
  sequence,
} from "../../src/server/index.ts";
import { defineRemote } from "../../src/remote/server.ts";
import { defineRemoteForm, remoteFormAction } from "../../src/remote/forms.ts";
import { dataMediaType } from "../../src/data/contract.ts";
import { readDataResponse } from "../../src/data/transport.ts";
import type { ApplicationOptions } from "../../src/server/types.ts";
const origin = "http://mutation.test";
async function fixture(options: Partial<ApplicationOptions> = {}) {
  const parent = resolve(".velveteen/mutations");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "integration-"));
  const routes = join(root, "routes");
  await mkdir(routes);
  await Bun.write(
    join(routes, "+page.svelte"),
    "<script>let {data,form}=$props();</script><h1>{data.identity}</h1><p>{form?.identity}</p>",
  );
  await Bun.write(
    join(routes, "+page.server.ts"),
    `import {getRequestEvent} from ${JSON.stringify(resolve("src/server/index.ts"))}; export const load=({locals,cookies})=>({identity:locals.identity,saved:cookies.get('saved')??null});export const actions={default:async(event)=>{await event.request.formData();event.cookies.set('saved',String(event.locals.identity),{path:'/'});return {identity:getRequestEvent().locals.identity};}};`,
  );
  await Bun.write(
    join(routes, "+server.ts"),
    `import {getRequestEvent} from ${JSON.stringify(resolve("src/server/index.ts"))}; export function GET(){return Response.json({identity:getRequestEvent().locals.identity});}`,
  );
  const generation = await buildProduction({
    projectDirectory: root,
    routesDirectory: routes,
    outputDirectory: join(root, "output"),
    basePath: "/app",
  });
  const app = await createApplication({ ...options, generation });
  return {
    app,
    generation,
    async dispose() {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function remoteRequest(
  name: string,
  input: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/app/_remote/${name}`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/x-velveteen-remote",
      ...headers,
    },
    body: stringify({ version: 1, name, input }),
  });
}

test("V: a dedicated form runs in the page request context without selecting its page action", async () => {
  let entered = 0;
  const app = await fixture({
    remoteForms: {
      save: defineRemoteForm({
        validate(data) {
          return String(data.get("record"));
        },
        handle(record, event) {
          expect(getRequestEvent()).toBe(event);
          expect(event.url.searchParams.get("/remote")).toBe("save");
          entered++;
          return { record };
        },
      }),
    },
  });
  const address = new URL(
    remoteFormAction(`${origin}/app?filter=current`, "save"),
    origin,
  );
  try {
    const submit = (originHeader: string) =>
      app.app.fetch(
        new Request(address, {
          method: "POST",
          headers: {
            accept: dataMediaType,
            origin: originHeader,
            "x-velveteen-action": "true",
          },
          body: new URLSearchParams({ record: "registered handler" }),
        }),
      );
    expect((await submit("http://other.test")).status).toBe(403);
    const response = await submit(origin);
    const { payload, done } = await readDataResponse(response);
    expect(payload.form).toEqual({ record: "registered handler" });
    expect(payload.status).toBe(200);
    expect(new URL(payload.url).searchParams.get("filter")).toBe("current");
    await done;
    expect(entered).toBe(1);
  } finally {
    await app.dispose();
  }
});
test("S: ordered middleware covers page, endpoint, action and remote lifecycles", async () => {
  let invocations = 0;
  const identities: string[] = [];
  let arrivals = 0;
  let releaseRemote: () => void = () => {};
  const remotePair = new Promise<void>((resolve) => {
    releaseRemote = resolve;
  });
  const app = await fixture({
    hooks: {
      handle: sequence(
        async ({ event, resolve }) => {
          event.locals.identity =
            event.request.headers.get("x-identity") ?? "anonymous";
          if (!event.request.headers.has("authorization"))
            return new Response("Unauthorized", { status: 401 });
          identities.push(String(event.locals.identity));
          return resolve();
        },
        async ({ event, resolve }) => {
          expect(getRequestEvent()).toBe(event);
          const order = (event.locals.order ??= []) as string[];
          order.push("first:pre");
          const forwarded = { ...event, locals: event.locals };
          const response = await resolve(forwarded);
          expect(getRequestEvent()).toBe(event);
          (event.locals.order as string[]).push("first:post");
          response.headers.set(
            "x-order",
            (event.locals.order as string[]).join(","),
          );
          return response;
        },
        async ({ event, resolve }) => {
          expect(getRequestEvent()).toBe(event);
          const order = (event.locals.order ??= []) as string[];
          order.push("second:pre");
          const response = await resolve();
          expect(getRequestEvent()).toBe(event);
          (event.locals.order as string[]).push("second:post");
          response.headers.set(
            "x-order",
            (event.locals.order as string[]).join(","),
          );
          return response;
        },
      ),
    },
    remotes: {
      echo: defineRemote({
        kind: "command",
        validate: (input) => {
          if (typeof input !== "string") throw new Error("PRIVATE_VALIDATOR");
          return input;
        },
        handle: async (input, event) => {
          invocations++;
          if (++arrivals === 2) releaseRemote();
          await remotePair;
          expect(getRequestEvent()).toBe(event);
          return { input, identity: event.locals.identity };
        },
      }),
    },
  });
  try {
    const deniedPage = await app.app.fetch(new Request(`${origin}/app/`));
    expect(deniedPage.status).toBe(401);
    expect(deniedPage.headers.get("x-order")).toBeNull();
    expect(await deniedPage.text()).toBe("Unauthorized");
    const deniedEndpoint = await app.app.fetch(
      new Request(`${origin}/app/`, {
        headers: { accept: "application/json" },
      }),
    );
    expect(deniedEndpoint.status).toBe(401);
    expect(deniedEndpoint.headers.get("x-order")).toBeNull();
    expect(await deniedEndpoint.text()).toBe("Unauthorized");
    expect((await app.app.fetch(remoteRequest("echo", "no"))).status).toBe(401);
    expect(identities).toEqual([]);
    expect(invocations).toBe(0);
    const page = await app.app.fetch(
      new Request(`${origin}/app/`, {
        headers: { authorization: "test", "x-identity": "Page" },
      }),
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("x-order")).toBe(
      "first:pre,second:pre,second:post,first:post",
    );
    await page.text();
    const endpoint = await app.app.fetch(
      new Request(`${origin}/app/`, {
        headers: {
          accept: "application/json",
          authorization: "test",
          "x-identity": "Endpoint",
        },
      }),
    );
    expect(await endpoint.json()).toEqual({ identity: "Endpoint" });
    expect(endpoint.headers.get("x-order")).toBe(
      "first:pre,second:pre,second:post,first:post",
    );
    const form = new URLSearchParams({ name: "value" });
    expect(
      (
        await app.app.fetch(
          new Request(`${origin}/app/`, {
            method: "POST",
            headers: { origin, accept: dataMediaType },
            body: form,
          }),
        )
      ).status,
    ).toBe(401);
    expect(invocations).toBe(0);
    const action = await app.app.fetch(
      new Request(`${origin}/app/`, {
        method: "POST",
        headers: {
          origin,
          accept: dataMediaType,
          "x-velveteen-action": "true",
          authorization: "test",
          "x-identity": "Action",
        },
        body: form,
      }),
    );
    expect(action.headers.get("set-cookie")).toContain("saved=Action");
    expect(action.headers.get("x-order")).toBe(
      "first:pre,second:pre,second:post,first:post",
    );
    const { payload, done } = await readDataResponse(action);
    await done;
    expect(payload.form).toEqual({ identity: "Action" });
    expect(payload.nodes.at(-1)?.data).toEqual({
      identity: "Action",
      saved: "Action",
    });
    const results = await Promise.all(
      ["One", "Two"].map(async (identity) => {
        const response = await app.app.fetch(
          remoteRequest("echo", identity, {
            authorization: "test",
            "x-identity": identity,
          }),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("x-order")).toBe(
          "first:pre,second:pre,second:post,first:post",
        );
        return parse(await response.text());
      }),
    );
    expect(results.map((result) => result.value)).toEqual([
      { input: "One", identity: "One" },
      { input: "Two", identity: "Two" },
    ]);
    expect(identities).toEqual(["Page", "Endpoint", "Action", "One", "Two"]);
  } finally {
    releaseRemote();
    await app.dispose();
  }
});
test("G03: remote invalid input and origin cannot invoke application code; errors stay private", async () => {
  let calls = 0;
  const app = await fixture({
    remotes: {
      echo: defineRemote({
        kind: "query",
        validate: (value) => {
          if (typeof value !== "string") throw new Error("PRIVATE_VALIDATION");
          return value;
        },
        handle: () => {
          calls++;
          throw new Error("PRIVATE_HANDLER");
        },
      }),
    },
  });
  try {
    for (const suppliedOrigin of ["https://foreign.test", "null", ""]) {
      const request = remoteRequest("echo", "x", { origin: suppliedOrigin });
      if (!suppliedOrigin) request.headers.delete("origin");
      const response = await app.app.fetch(request);
      expect(response.status).toBe(403);
      await response.text();
    }
    for (const name of ["constructor", "__proto__", "missing"]) {
      const response = await app.app.fetch(remoteRequest(name, "x"));
      expect(response.status).toBe(404);
      await response.text();
    }
    const invalid = await app.app.fetch(remoteRequest("echo", 42));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("PRIVATE");
    expect(calls).toBe(0);
    const failed = await app.app.fetch(remoteRequest("echo", "x"));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("PRIVATE");
    expect(calls).toBe(1);
    const malformed = await app.app.fetch(
      new Request(`${origin}/app/_remote/%`, {
        method: "POST",
        headers: { origin, "content-type": "application/x-velveteen-remote" },
        body: "bad",
      }),
    );
    expect(malformed.status).toBe(400);
    await malformed.text();
  } finally {
    await app.dispose();
  }
});

test("G03: form CSRF treats media types case-insensitively before actions run", async () => {
  const application = await fixture();
  try {
    const response = await application.app.fetch(
      new Request(`${origin}/app/`, {
        method: "POST",
        headers: {
          origin: "https://foreign.test",
          accept: "text/html",
          "content-type": "Application/X-WWW-Form-Urlencoded",
        },
        body: "name=foreign",
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.has("set-cookie")).toBe(false);
  } finally {
    await application.dispose();
  }
});
