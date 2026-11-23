import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { compile } from "svelte/compiler";
import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

type Application = {
  generation: string;
  initialize(): () => void;
  renderPage(): string;
  subscribeRequest(): () => void;
};
type Generation = {
  ticket: number;
  graph: Bun.ModuleGraph;
  application: Application;
  cleanup(): void;
  resources: Set<() => void>;
  requests: number;
  retired: boolean;
  disposed: boolean;
};

test("P10: native ModuleGraph publication preserves requests and disposes actual application resources", async () => {
  const root = resolve(import.meta.dir, "../..");
  await mkdir(join(root, ".velveteen/lifecycle"), { recursive: true });
  const directory = await mkdtemp(
    join(root, ".velveteen/lifecycle/publication-"),
  );
  const events = new EventTarget();
  const callbacks: string[] = [];
  const initialized: string[] = [];
  const allGenerations: Generation[] = [];
  const failedResources: Set<() => void>[] = [];
  let requestResources = 0;
  let ticket = 0;
  const componentSource = `<script>import { value } from "./value.ts";</script><p id="proof">Original: {value}</p>`;
  await Bun.write(join(directory, "value.ts"), 'export const value = "A";');
  for (const [generate, file] of [
    ["server", "proof.ts"],
    ["client", "browser.ts"],
  ] as const) {
    const compiled = compile(componentSource, {
      filename: "proof.svelte",
      generate,
    });
    await Bun.write(join(directory, file), compiled.js.code);
  }
  const browserBuild = await Bun.build({
    entrypoints: [join(directory, "browser.ts")],
    target: "browser",
  });
  expect(browserBuild.success).toBe(true);
  expect(browserBuild.outputs.length).toBeGreaterThan(0);
  expect(browserBuild.logs).toEqual([]);
  await Bun.write(
    join(directory, "entry.ts"),
    `import {render} from 'svelte/server'; import Proof from './proof.ts'; import {value} from './value.ts';
declare const scope: { observe(value: string): void; listen(value: string): () => void; request(): () => void; };
scope.observe(value);
export const generation=value;
export function initialize(){ const remove=scope.listen(value); if(value==='FAIL')throw new Error('candidate initialization failed'); return remove; }
export const renderPage=()=>render(Proof).body;
export const subscribeRequest=()=>scope.request();`,
  );

  async function prepare(
    value: string,
    gate: Promise<void> = Promise.resolve(),
  ): Promise<Generation> {
    const generationTicket = ++ticket;
    await gate;
    const resources = new Set<() => void>();
    const graph = new Bun.ModuleGraph({
      globals: {
        scope: {
          observe: (value: string) => initialized.push(value),
          listen: (value: string) => {
            const listener = () => callbacks.push(value);
            events.addEventListener("tick", listener);
            const remove = () => {
              events.removeEventListener("tick", listener);
              resources.delete(remove);
            };
            resources.add(remove);
            return remove;
          },
          request: () => {
            const listener = () => undefined;
            events.addEventListener("request-event", listener);
            requestResources += 1;
            let active = true;
            return () => {
              if (active) {
                active = false;
                events.removeEventListener("request-event", listener);
                requestResources -= 1;
              }
            };
          },
        },
      },
    });
    try {
      await Bun.write(
        join(directory, "value.ts"),
        value === "SYNTAX"
          ? "export const value = ;"
          : `export const value=${JSON.stringify(value)};`,
      );
      const application = await graph.import<Application>(
        join(directory, "entry.ts"),
      );
      const cleanup = graph.run(() => application.initialize());
      const generation: Generation = {
        ticket: generationTicket,
        graph,
        application,
        cleanup,
        resources,
        requests: 0,
        retired: false,
        disposed: false,
      };
      allGenerations.push(generation);
      return generation;
    } catch (error) {
      for (const remove of resources) remove();
      failedResources.push(resources);
      graph.dispose();
      expect(() => graph.run(() => undefined)).toThrow();
      throw error;
    }
  }
  const disposeIfDrained = (generation: Generation) => {
    if (
      generation.retired &&
      generation.requests === 0 &&
      !generation.disposed
    ) {
      generation.graph.dispose();
      generation.disposed = true;
      expect(() => generation.graph.run(() => undefined)).toThrow();
    }
  };
  const retire = (generation: Generation) => {
    generation.graph.run(generation.cleanup);
    expect(generation.resources.size).toBe(0);
    generation.retired = true;
    disposeIfDrained(generation);
  };
  let current = await prepare("A");
  const holds = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const admissions = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const abortDone = Promise.withResolvers<void>();
  const abortAdmission = Promise.withResolvers<void>();
  const handler =
    (generation: Generation) =>
    async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      generation.requests += 1;
      let cleanup: (() => void) | undefined;
      try {
        if (url.pathname === "/hold") {
          const identifier = url.searchParams.get("identifier")!;
          admissions.get(identifier)!.resolve();
          await holds.get(identifier)!.promise;
        }
        if (url.pathname === "/abort") {
          cleanup = generation.graph.run(() =>
            generation.application.subscribeRequest(),
          );
          const aborted = Promise.withResolvers<void>();
          request.signal.addEventListener("abort", () => aborted.resolve(), {
            once: true,
          });
          abortAdmission.resolve();
          await aborted.promise;
        }
        const body = generation.graph.run(() =>
          generation.application.renderPage(),
        );
        return new Response(body, { headers: { "content-type": "text/html" } });
      } finally {
        if (cleanup) {
          generation.graph.run(cleanup);
          abortDone.resolve();
        }
        generation.requests -= 1;
        disposeIfDrained(generation);
      }
    };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler(current),
  });
  const address = server.url.href;
  const publish = (candidate: Generation) => {
    if (candidate.ticket !== ticket) {
      retire(candidate);
      return false;
    }
    const previous = current;
    current = candidate;
    server.reload({ fetch: handler(current) });
    retire(previous);
    return true;
  };
  const tick = () => {
    callbacks.length = 0;
    events.dispatchEvent(new Event("tick"));
    return [...callbacks];
  };
  const hold = (identifier: string) => {
    holds.set(identifier, Promise.withResolvers<void>());
    admissions.set(identifier, Promise.withResolvers<void>());
    return fetch(new URL(`/hold?identifier=${identifier}`, address));
  };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(address);
    const heldA = hold("A");
    await admissions.get("A")!.promise;
    const old = current;
    expect(publish(await prepare("B"))).toBe(true);
    expect(server.url.href).toBe(address);
    expect(old.disposed).toBe(false);
    expect(tick()).toEqual(["B"]);
    expect(await (await fetch(address)).text()).toContain("Original: B");
    expect(
      await page.evaluate(() => fetch("/").then((response) => response.text())),
    ).toContain("Original: B");
    holds.get("A")!.resolve();
    expect(await (await heldA).text()).toContain("Original: A");
    expect(old.disposed).toBe(true);
    expect(await throwingRejectionOf(prepare("SYNTAX"))).toThrow();
    expect(await throwingRejectionOf(prepare("FAIL"))).toThrow(
      "candidate initialization failed",
    );
    expect(failedResources.map((resources) => resources.size)).toEqual([0, 0]);
    expect(tick()).toEqual(["B"]);
    expect(await (await fetch(address)).text()).toContain("Original: B");
    const controller = new AbortController();
    const aborted = fetch(new URL("/abort", address), {
      signal: controller.signal,
    }).catch((error: unknown) =>
      error instanceof Error ? error.name : String(error),
    );
    await abortAdmission.promise;
    expect(requestResources).toBe(1);
    controller.abort();
    expect(await aborted).toBe("AbortError");
    await abortDone.promise;
    expect(requestResources).toBe(0);
    for (let index = 0; index < 10; index++) {
      const value = `edit-${index}`;
      expect(publish(await prepare(value))).toBe(true);
      expect(tick()).toEqual([value]);
      expect(await (await fetch(address)).text()).toContain(
        `Original: ${value}`,
      );
    }
    const staleGate = Promise.withResolvers<void>();
    const stale = prepare("STALE", staleGate.promise);
    const fresh = await prepare("LATEST");
    expect(publish(fresh)).toBe(true);
    staleGate.resolve();
    const staleCandidate = await stale;
    expect(publish(staleCandidate)).toBe(false);
    expect(staleCandidate.disposed).toBe(true);
    expect(tick()).toEqual(["LATEST"]);
    expect(await (await fetch(address)).text()).toContain("Original: LATEST");
    const heldShutdown = hold("shutdown");
    await admissions.get("shutdown")!.promise;
    let stopped = false;
    const stopping = server.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    holds.get("shutdown")!.resolve();
    expect(await (await heldShutdown).text()).toContain("Original: LATEST");
    await stopping;
    retire(current);
    expect(tick()).toEqual([]);
    expect(
      allGenerations.every(
        (generation) => generation.disposed && generation.resources.size === 0,
      ),
    ).toBe(true);
    expect(initialized).toEqual([
      "A",
      "B",
      "FAIL",
      ...Array.from({ length: 10 }, (_, index) => `edit-${index}`),
      "LATEST",
      "STALE",
    ]);
    await Bun.write(
      join(root, ".velveteen/evidence/p10-module-graph-publication.json"),
      JSON.stringify(
        {
          bun: Bun.version,
          listener: address,
          initialized,
          retiredGenerations: allGenerations.length,
          failedCandidates: failedResources.length,
          requestResources,
          browserBuildSucceeded: browserBuild.success,
          status: "passed",
          limitation:
            "Buffered SSR, explicit application cleanup, experimental ModuleGraph; streaming disposal and general memory bounds are not certified",
        },
        null,
        2,
      ),
    );
  } finally {
    for (const release of holds.values()) release.resolve();
    await browser.close();
    await server.stop(true);
    for (const generation of allGenerations)
      if (!generation.disposed) retire(generation);
    await rm(directory, { recursive: true, force: true });
  }
});
