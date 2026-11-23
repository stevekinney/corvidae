import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { chromium, type Browser } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildProduction } from "../../src/build/index.ts";
import { createApplication } from "../../src/server/index.ts";
import type { RequestEvent, ServerRegistry } from "../../src/server/types.ts";

type Published = {
  graph: Bun.ModuleGraph;
  application: Awaited<ReturnType<typeof createApplication>>;
  generation: Awaited<ReturnType<typeof buildProduction>>;
  disposed: boolean;
};

test("W: native reload drains admitted HTTP streams and releases retired graphs", async () => {
  const parent = join(import.meta.dir, "../../.velveteen/lifecycle");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "application-"));
  const routes = join(root, "routes");
  const output = join(root, "output");
  let listener: ReturnType<typeof Bun.serve> | undefined;
  let browserInstance: Browser | undefined;
  const held = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const admitted = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const streamAborted = Promise.withResolvers<void>();
  const streamCanceled = Promise.withResolvers<void>();
  const streamFirstPull = Promise.withResolvers<void>();
  const streamCancelStarted = Promise.withResolvers<void>();
  const finishStreamCancellation = Promise.withResolvers<void>();
  let streamPulls = 0;
  let heldFetch: RequestEvent["fetch"] | undefined;
  const generations: Published[] = [];
  const prepare = async (): Promise<Published> => {
    const generation = await buildProduction({
      projectDirectory: root,
      routesDirectory: routes,
      outputDirectory: output,
      mode: "development",
    });
    const graph = new Bun.ModuleGraph();
    try {
      const imported = await graph.import<ServerRegistry>(
        join(generation.directory, generation.manifest.server.file),
      );
      const application = await createApplication({
        generation,
        registry: imported,
        hooks: {
          handle: async ({ event, resolve }) => {
            event.locals.generationRequest =
              event.url.searchParams.get("hold") ?? "current";
            if (event.url.searchParams.has("stream")) {
              return new Response(
                new ReadableStream<Uint8Array>(
                  {
                    start(controller) {
                      event.signal.addEventListener(
                        "abort",
                        () => {
                          streamAborted.resolve();
                          controller.error(event.signal.reason);
                        },
                        { once: true },
                      );
                    },
                    pull(controller) {
                      streamPulls++;
                      controller.enqueue(
                        new TextEncoder().encode(`stream-${streamPulls}`),
                      );
                      streamFirstPull.resolve();
                    },
                    async cancel() {
                      streamCancelStarted.resolve();
                      await streamAborted.promise;
                      await finishStreamCancellation.promise;
                      streamCanceled.resolve();
                    },
                  },
                  { highWaterMark: 0 },
                ),
              );
            }
            const id = event.url.searchParams.get("hold");
            if (id) {
              heldFetch = event.fetch;
              held.set(id, Promise.withResolvers<void>());
              admitted.get(id)?.resolve();
              const encoder = new TextEncoder();
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(encoder.encode(`held-${id}-start`));
                  },
                  async pull(controller) {
                    await held.get(id)!.promise;
                    const originalValue = await (
                      await event.fetch("/value")
                    ).text();
                    controller.enqueue(
                      encoder.encode(`held-${originalValue}-end`),
                    );
                    controller.close();
                  },
                }),
              );
            }
            return resolve();
          },
        },
      });
      const published = { graph, application, generation, disposed: false };
      generations.push(published);
      return published;
    } catch (cause) {
      graph.dispose();
      throw cause;
    }
  };
  try {
    await mkdir(join(routes, "value"), { recursive: true });
    await Bun.write(
      join(routes, "+page.svelte"),
      `<script lang="ts">let {data}: {data: {value: string}} = $props(); let count = $state(0);</script><h1>{data.value}</h1><button onclick={() => count++}>{count}</button>`,
    );
    await Bun.write(
      join(routes, "+page.server.ts"),
      `import {value} from '../value.ts';import {getRequestEvent} from ${JSON.stringify(join(import.meta.dir, "../../src/server/context.ts"))}; export const load=async()=>({value,context:getRequestEvent().locals.generationRequest});`,
    );
    await Bun.write(join(root, "value.ts"), `export const value='A';`);
    await Bun.write(
      join(routes, "value/+server.ts"),
      `import {value} from '../../value.ts'; export const GET=()=>new Response(value);`,
    );
    let current = await prepare();
    const server = (listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: current.application.fetch,
    }));
    const address = server.url.href;
    const browser = (browserInstance = await chromium.launch());
    const page = await browser.newPage();
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    const publish = (next: Published) => {
      const previous = current;
      current = next;
      server.reload({ fetch: next.application.fetch });
      return previous;
    };
    const closeRetired = async (retired: Published) => {
      await retired.application.retire();
      retired.graph.dispose();
      retired.disposed = true;
      expect(
        await throwingRejectionOf(
          retired.graph.import(
            join(
              retired.generation.directory,
              retired.generation.manifest.server.file,
            ),
          ),
        ),
      ).toThrow("ModuleGraph has been disposed");
    };
    await page.goto(address);
    expect(await page.locator("h1").textContent()).toBe("A");
    await page.getByRole("button").click();
    expect(await page.getByRole("button").textContent()).toBe("1");
    expect(browserErrors).toEqual([]);
    admitted.set("A", Promise.withResolvers<void>());
    const heldResponse = fetch(`${address}?hold=A`);
    await admitted.get("A")!.promise;
    const heldReader = (await heldResponse).body!.getReader();
    expect(new TextDecoder().decode((await heldReader.read()).value)).toBe(
      "held-A-start",
    );
    await Bun.write(join(root, "value.ts"), `export const value='B';`);
    const next = await prepare();
    const previous = publish(next);
    expect(server.url.href).toBe(address);
    expect(await (await fetch(address)).text()).toContain("B");
    const data = await fetch(address, {
      headers: { accept: "application/x-velveteen-data" },
    });
    expect(await data.text()).toContain("B");
    expect(
      await page.evaluate(
        (url) =>
          fetch(url, {
            headers: { accept: "application/x-velveteen-data" },
          }).then((response) => response.text()),
        address,
      ),
    ).toContain("B");
    expect(previous.disposed).toBe(false);

    const retiring = previous.application.retire();
    expect(previous.application.retire()).toBe(retiring);
    let drained = false;
    void retiring.then(() => {
      drained = true;
    });
    expect(
      (await previous.application.fetch(new Request(address))).status,
    ).toBe(503);
    expect(drained).toBe(false);
    held.get("A")!.resolve();
    expect(new TextDecoder().decode((await heldReader.read()).value)).toBe(
      "held-A-end",
    );
    expect((await heldReader.read()).done).toBe(true);
    await retiring;

    expect((await heldFetch!("/value")).status).toBe(503);
    await closeRetired(previous);
    expect(current.disposed).toBe(false);
    const streamResponse = await current.application.fetch(
      new Request(`${address}?stream=1`),
    );
    await streamFirstPull.promise;
    expect(streamPulls).toBe(1);
    const streamReader = streamResponse.body!.getReader();
    expect(new TextDecoder().decode((await streamReader.read()).value)).toBe(
      "stream-1",
    );
    await Bun.write(join(root, "value.ts"), `export const value='C';`);
    const canceledGeneration = publish(await prepare());
    const streamRetiring = canceledGeneration.application.retire();
    let streamDrained = false;
    void streamRetiring.then(() => {
      streamDrained = true;
    });
    expect((await fetch(address + "value")).status).toBe(200);
    expect(await (await fetch(address + "value")).text()).toBe("C");
    expect(streamPulls).toBe(2);
    const canceling = streamReader.cancel("consumer canceled");
    await streamCancelStarted.promise;
    await streamAborted.promise;
    expect(streamDrained).toBe(false);
    finishStreamCancellation.resolve();
    await canceling;
    await streamCanceled.promise;
    await closeRetired(canceledGeneration);

    for (const value of ["D", "E", "F", "G", "H"]) {
      await Bun.write(join(root, "value.ts"), `export const value='${value}';`);
      const candidate = await prepare();
      const retired = publish(candidate);
      expect(generations.filter(({ disposed }) => !disposed)).toHaveLength(2);
      await closeRetired(retired);
      expect(generations.filter(({ disposed }) => !disposed)).toHaveLength(1);
      expect(await (await fetch(address + "value")).text()).toBe(value);
    }

    await Bun.write(join(root, "value.ts"), "export const value=;");
    expect(
      await throwingRejectionOf(
        buildProduction({
          projectDirectory: root,
          routesDirectory: routes,
          outputDirectory: output,
          mode: "development",
        }),
      ),
    ).toThrow();
    expect(await (await fetch(address + "value")).text()).toBe("H");
  } finally {
    finishStreamCancellation.resolve();
    for (const gate of held.values()) gate.resolve();
    await listener?.stop(true);
    await browserInstance?.close();
    for (const generation of generations)
      if (!generation.disposed) {
        await generation.application.dispose();
        generation.graph.dispose();
        generation.disposed = true;
      }
    await rm(root, { recursive: true, force: true });
  }
});
