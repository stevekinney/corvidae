import { expect, test } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

type RouteHandler = () => Response | Promise<Response>;
const evidencePath = join(
  import.meta.dir,
  "../../.velveteen/evidence/p09-entry-discovery.json",
);

test("P09: filesystem entry add, rename, and delete publish on one listener", async () => {
  const directory = await mkdtemp(
    join(import.meta.dir, "../../.velveteen/lifecycle/entries-"),
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const slowHandler: RouteHandler = async () => {
    entered.resolve();
    await release.promise;
    return new Response("slow-A");
  };
  let generation = 0;
  const buildEntries = async () => {
    const glob = new Bun.Glob("*.ts");
    const paths = (
      await Array.fromAsync(glob.scan({ cwd: directory, absolute: true }))
    ).sort();
    const routes: Record<string, RouteHandler> = { "/slow": slowHandler };
    for (const path of paths) {
      const name = basename(path, extname(path));
      const body = await readFile(path, "utf8");
      routes[`/${name}`] = () =>
        new Response(body, { headers: { "content-type": "text/plain" } });
    }
    return { routes, generation: ++generation };
  };
  const initial = await buildEntries();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: initial.routes,
    fetch: () => new Response("not found", { status: 404 }),
  });
  const address = server.url.href;
  const processId = process.pid;
  let pending = Promise.resolve();
  const failures: unknown[] = [];
  const generationWaiters: Array<{ target: number; resolve: () => void }> = [];
  const applyChange = async () => {
    const next = await buildEntries();
    server.reload({
      routes: next.routes,
      fetch: () => new Response("not found", { status: 404 }),
    });
    for (const waiter of generationWaiters.splice(0)) {
      if (generation >= waiter.target) waiter.resolve();
      else generationWaiters.push(waiter);
    }
  };
  const watcher = watch(directory, (_event, filename) => {
    if (!filename) return;
    pending = pending.then(applyChange).catch((error: unknown) => {
      failures.push(error);
    });
  });
  const waitForGeneration = async (target: number) => {
    if (generation >= target) return;
    await new Promise<void>((resolve) =>
      generationWaiters.push({ target, resolve }),
    );
  };
  try {
    expect((await fetch(new URL("/alpha", address))).status).toBe(404);
    const held = fetch(new URL("/slow", address));
    await entered.promise;
    const alphaPath = join(directory, "alpha.ts");
    const alphaGeneration = generation + 1;
    const alphaChange = waitForGeneration(alphaGeneration);
    await writeFile(alphaPath, "alpha");
    await alphaChange;
    await pending;
    expect(failures).toEqual([]);
    expect(await (await fetch(new URL("/alpha", address))).text()).toBe(
      "alpha",
    );
    expect(server.url.href).toBe(address);
    expect(process.pid).toBe(processId);
    release.resolve();
    expect(await (await held).text()).toBe("slow-A");
    const betaPath = join(directory, "beta.ts");
    const renameGeneration = generation + 1;
    const renameChange = waitForGeneration(renameGeneration);
    await rename(alphaPath, betaPath);
    await renameChange;
    await pending;
    expect(failures).toEqual([]);
    expect((await fetch(new URL("/alpha", address))).status).toBe(404);
    expect(await (await fetch(new URL("/beta", address))).text()).toBe("alpha");
    const deleteGeneration = generation + 1;
    const deleteChange = waitForGeneration(deleteGeneration);
    await rm(betaPath);
    await deleteChange;
    await pending;
    expect(failures).toEqual([]);
    expect((await fetch(new URL("/beta", address))).status).toBe(404);
    expect(server.url.href).toBe(address);
    await Bun.write(
      evidencePath,
      JSON.stringify(
        {
          probe: "P09-entry-discovery",
          listener: address,
          pid: processId,
          baseline: "/alpha=404",
          add: "/alpha=200",
          rename: "/alpha=404,/beta=200",
          delete: "/beta=404",
          heldRequest: "slow-A",
          publication: "full-filesystem-rescan-before-server.reload",
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    release.resolve();
    watcher.close();
    await pending;
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
  expect(failures).toEqual([]);
});
