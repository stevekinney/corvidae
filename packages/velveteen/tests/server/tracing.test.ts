import { rejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildProduction } from "../../src/build/index.ts";
import {
  createApplication,
  type RequestTraceSpan,
} from "../../src/server/index.ts";
import { readDataResponse } from "../../src/data/transport.ts";
import { dataMediaType } from "../../src/data/contract.ts";

const origin = "http://tracing.test";

async function fixture(onTrace: (span: RequestTraceSpan) => void) {
  const parent = resolve(".velveteen/tracing");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "integration-"));
  const routes = join(root, "routes");
  const actions = resolve("src/actions/server.ts");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let held = false;
  let bodyCanceled = false;
  try {
    await mkdir(join(routes, "nested"), { recursive: true });
    await Bun.write(
      join(routes, "+layout.svelte"),
      "<script>let {children}=$props();</script>{@render children()}",
    );
    await Bun.write(
      join(routes, "+layout.server.ts"),
      "export const load=({url})=>({root:url.pathname});",
    );
    await Bun.write(
      join(routes, "+layout.ts"),
      "export const load=({data})=>({universal:`${data.root}:universal`});",
    );
    await Bun.write(
      join(routes, "nested", "+page.svelte"),
      "<script>let {data}= $props();</script><h1>{data.value}</h1>",
    );
    await Bun.write(
      join(routes, "nested", "+page.ts"),
      "export const load=async({parent})=>({value:`${(await parent()).universal}:page`});",
    );
    await Bun.write(
      join(routes, "nested", "+page.server.ts"),
      `import {fail} from ${JSON.stringify(actions)};
export const load=async({url,locals})=>{if(url.searchParams.has("hold"))await locals.holdLoad();if(url.searchParams.has("load-error"))throw new Error("PRIVATE_LOAD_ERROR");return {server:"nested"};};
export const actions={default:async({request})=>{const form=await request.formData();const mode=String(form.get("mode")??"");if(mode==="invalid")return fail(422,{message:"invalid input"});if(mode==="crash")throw new Error("PRIVATE_ACTION_ERROR");return {saved:"yes"};}};`,
    );
    const generation = await buildProduction({
      projectDirectory: root,
      routesDirectory: routes,
      outputDirectory: join(root, "output"),
      basePath: "/app",
    });
    const app = await createApplication({
      generation,
      onTrace,
      hooks: {
        handle({ event, resolve }) {
          event.locals.holdLoad = async () => {
            held = true;
            entered.resolve();
            await release.promise;
            completed.resolve();
          };
          if (!event.url.searchParams.has("hold-body")) return resolve();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("body stays open"));
              },
              cancel() {
                bodyCanceled = true;
              },
            }),
          );
        },
      },
    });
    return {
      app,
      entered,
      release,
      completed,
      get bodyCanceled() {
        return bodyCanceled;
      },
      async dispose() {
        release.resolve();
        if (held) await completed.promise;
        await app.dispose();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    await rm(root, { recursive: true, force: true });
    throw cause;
  }
}

function request(path: string, init?: RequestInit) {
  return new Request(`${origin}/app${path}`, init);
}

function latestTrace(spans: RequestTraceSpan[]) {
  const traceId = spans.findLast((span) => span.name === "request")?.traceId;
  expect(traceId).toBeDefined();
  return spans.filter((span) => span.traceId === traceId);
}

function assertTrace(
  spans: RequestTraceSpan[],
  outcome: RequestTraceSpan["outcome"],
  status?: number,
) {
  const roots = spans.filter((span) => span.name === "request");
  expect(roots).toHaveLength(1);
  const [root] = roots;
  expect(root.parentSpanId).toBeNull();
  expect(root.outcome).toBe(outcome);
  if (status !== undefined) expect(root.status).toBe(status);
  for (const span of spans) {
    expect(span.traceId).toBe(root.traceId);
    expect(span.routeId).toBe("/nested");
    expect(span.spanId).not.toBe(span.parentSpanId);
    expect(span.startTime).toBeLessThanOrEqual(span.endTime);
    if (span.name !== "request") expect(span.parentSpanId).toBe(root.spanId);
  }
  expect(new Set(spans.map((span) => span.spanId)).size).toBe(spans.length);
}

test("X: traces correlate nested loads, actions, failures, and cancellation", async () => {
  const spans: RequestTraceSpan[] = [];
  const app = await fixture((span) => spans.push({ ...span }));
  try {
    const page = await app.app.fetch(request("/nested"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/app/nested:universal:page");
    const pageSpans = latestTrace(spans);
    expect(pageSpans.map((span) => span.name).sort()).toEqual([
      "request",
      "server.load",
      "server.load",
      "universal.load",
      "universal.load",
    ]);
    assertTrace(pageSpans, "success", 200);

    const action = await app.app.fetch(
      request("/nested", {
        method: "POST",
        headers: {
          accept: dataMediaType,
          origin,
          "x-velveteen-action": "true",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "mode=ok",
      }),
    );
    expect(action.status).toBe(200);
    expect(await action.text()).toContain("saved");
    const actionSpans = latestTrace(spans);
    expect(actionSpans[0].traceId).not.toBe(pageSpans[0].traceId);
    assertTrace(actionSpans, "success", 200);
    expect(actionSpans.find((span) => span.name === "action")).toMatchObject({
      outcome: "success",
    });

    const invalid = await app.app.fetch(
      request("/nested", {
        method: "POST",
        headers: {
          accept: dataMediaType,
          origin,
          "x-velveteen-action": "true",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "mode=invalid",
      }),
    );
    expect(invalid.status).toBe(200);
    const invalidData = await readDataResponse(invalid);
    expect(invalidData.payload.status).toBe(422);
    await invalidData.done;
    const invalidSpans = latestTrace(spans);
    assertTrace(invalidSpans, "error", 422);
    expect(invalidSpans.find((span) => span.name === "action")).toMatchObject({
      outcome: "error",
      status: 422,
    });

    const crashed = await app.app.fetch(
      request("/nested", {
        method: "POST",
        headers: {
          origin,
          "x-velveteen-action": "true",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "mode=crash",
      }),
    );
    expect(crashed.status).toBe(500);
    expect(await crashed.text()).not.toContain("PRIVATE_ACTION_ERROR");
    const crashSpans = latestTrace(spans);
    assertTrace(crashSpans, "error", 500);
    expect(crashSpans.find((span) => span.name === "action")).toMatchObject({
      outcome: "error",
    });

    const invalidLoad = await app.app.fetch(request("/nested?load-error=1"));
    expect(invalidLoad.status).toBe(500);
    expect(await invalidLoad.text()).not.toContain("PRIVATE_LOAD_ERROR");
    const invalidLoadSpans = latestTrace(spans);
    assertTrace(invalidLoadSpans, "error", 500);
    expect(invalidLoadSpans).toContainEqual(
      expect.objectContaining({ name: "server.load", outcome: "error" }),
    );

    const controller = new AbortController();
    const held = app.app.fetch(
      request("/nested?hold=PRIVATE_QUERY", { signal: controller.signal }),
    );
    await app.entered.promise;
    const overlapping = await app.app.fetch(request("/nested"));
    expect(overlapping.status).toBe(200);
    await overlapping.text();
    const overlappingSpans = latestTrace(spans);
    assertTrace(overlappingSpans, "success", 200);
    controller.abort("held request canceled");
    expect(await rejectionOf(held)).toBe("held request canceled");
    const canceled = latestTrace(spans);
    assertTrace(canceled, "canceled");
    expect(canceled[0].traceId).not.toBe(overlappingSpans[0].traceId);
    expect(canceled).toContainEqual(
      expect.objectContaining({
        name: "server.load",
        outcome: "canceled",
      }),
    );
    app.release.resolve();
    await app.completed.promise;

    const streamed = await app.app.fetch(request("/nested?hold-body=1"));
    const reader = streamed.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "body stays open",
    );
    await reader.cancel("consumer canceled");
    expect(app.bodyCanceled).toBe(true);
    assertTrace(latestTrace(spans), "canceled", 200);
    expect(spans.filter((span) => span.name === "request")).toHaveLength(8);
    expect(JSON.stringify(spans)).not.toContain("PRIVATE_ACTION_ERROR");
    expect(JSON.stringify(spans)).not.toContain("PRIVATE_LOAD_ERROR");
    expect(JSON.stringify(spans)).not.toContain("PRIVATE_QUERY");
  } finally {
    await app.dispose();
  }
});

test("X: trace observer failures do not alter responses or expose request data", async () => {
  const app = await fixture((span) => {
    if (span.name === "request")
      return Promise.reject(new Error("PRIVATE_ASYNC_OBSERVER_ERROR"));
    throw new Error("PRIVATE_OBSERVER_ERROR");
  });
  try {
    const response = await app.app.fetch(request("/nested?secret=PRIVATE_URL"));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("PRIVATE_OBSERVER_ERROR");
    expect(body).not.toContain("PRIVATE_ASYNC_OBSERVER_ERROR");
  } finally {
    await app.dispose();
  }
});
