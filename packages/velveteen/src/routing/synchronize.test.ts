import {
  rejectionOf,
  throwingRejectionOf,
} from "@lostgradient/testing/promise-outcome";
import { quietFor } from "@lostgradient/testing/wait-until";
import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRouteDispatcher, matchRoute } from "./index.ts";
import { synchronizeRoutes, type RoutePublication } from "./synchronize.ts";

test("C06: real file changes synchronize declarations and both routing consumers on one listener", async () => {
  const parent = join(import.meta.dir, "../../.velveteen/routing");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "synchronize-"));
  const routesDirectory = join(directory, "routes");
  const typesDirectory = join(directory, "types");
  await mkdir(routesDirectory);
  await mkdir(typesDirectory);
  await Bun.write(join(routesDirectory, "+page.svelte"), "<h1>Home</h1>");
  const unrelated = join(typesDirectory, "application-owned.d.ts");
  await Bun.write(unrelated, "export type ApplicationOwned = true;\n");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 404 }),
  });
  const address = server.url.href;
  const failures: unknown[] = [];
  const publications: RoutePublication[] = [];
  const subscriptions = new Set<(publication: RoutePublication) => void>();
  const errors = new Set<(error: unknown) => void>();
  const waitFor = (predicate: (publication: RoutePublication) => boolean) => {
    const result = Promise.withResolvers<RoutePublication>();
    const listener = (publication: RoutePublication) => {
      if (predicate(publication)) {
        subscriptions.delete(listener);
        result.resolve(publication);
      }
    };
    subscriptions.add(listener);
    return result.promise;
  };
  const synchronization = await synchronizeRoutes({
    routesDirectory,
    typesDirectory,
    publish(publication) {
      server.reload(
        createRouteDispatcher(publication.manifest, (_request, match) =>
          Response.json({ id: match.route.id, params: match.params }),
        ),
      );
      publications.push(publication);
      for (const listener of subscriptions) listener(publication);
    },
    onError(error) {
      failures.push(error);
      for (const listener of errors) listener(error);
    },
  });
  try {
    const check = async (
      pathname: string,
      id: string,
      params: Record<string, string>,
    ) => {
      const fetchedResponse = await fetch(new URL(pathname, address));
      expect(await fetchedResponse.json()).toEqual({
        id,
        params,
      });
      const matched = matchRoute(synchronization.current.client, pathname);
      expect(matched?.route.id).toBe(id);
      expect(matched?.params).toEqual(params);
      expect(server.url.href).toBe(address);
    };
    await check("/", "/", {});
    const alpha = join(routesDirectory, "alpha/[id]");
    await mkdir(alpha, { recursive: true });
    const added = waitFor(({ manifest }) =>
      manifest.routes.some((route) => route.id === "/alpha/[id]"),
    );
    await Bun.write(join(alpha, "+page.svelte"), "<h1>Alpha</h1>");
    await added;
    await check("/alpha/a%2Fb", "/alpha/[id]", { id: "a/b" });
    expect(
      await Bun.file(join(typesDirectory, "alpha/[id]/$types.d.ts")).exists(),
    ).toBe(true);

    const renamed = waitFor(
      ({ manifest }) =>
        manifest.routes.some((route) => route.id === "/beta/[id]") &&
        !manifest.routes.some((route) => route.id === "/alpha/[id]"),
    );
    await rename(join(routesDirectory, "alpha"), join(routesDirectory, "beta"));
    await renamed;
    await check("/beta/value", "/beta/[id]", { id: "value" });
    const fetchedResponse2 = await fetch(new URL("/alpha/value", address));
    expect(fetchedResponse2.status).toBe(404);
    expect(
      await Bun.file(join(typesDirectory, "alpha/[id]/$types.d.ts")).exists(),
    ).toBe(false);
    expect(
      await Bun.file(join(typesDirectory, "beta/[id]/$types.d.ts")).exists(),
    ).toBe(true);

    const invalid = join(routesDirectory, "broken/[id]/[id]");
    await mkdir(invalid, { recursive: true });
    const rejected = Promise.withResolvers<unknown>();
    errors.add(rejected.resolve);
    const previous = synchronization.current;
    await Bun.write(
      join(invalid, "+page.svelte"),
      "<h1>Invalid duplicate parameter</h1>",
    );
    await rejected.promise;
    errors.delete(rejected.resolve);
    expect(synchronization.current).toEqual(previous);
    await check("/beta/retained", "/beta/[id]", { id: "retained" });
    expect(
      await Bun.file(
        join(typesDirectory, "broken/[id]/[id]/$types.d.ts"),
      ).exists(),
    ).toBe(false);
    const repaired = waitFor(
      ({ manifest }) =>
        !manifest.nodes.some((node) => node.directory.startsWith("broken")),
    );
    await rm(join(routesDirectory, "broken"), { recursive: true });
    await repaired;

    const deleted = waitFor(
      ({ manifest }) =>
        !manifest.routes.some((route) => route.id === "/beta/[id]"),
    );
    await rm(join(routesDirectory, "beta"), { recursive: true });
    await deleted;
    const fetchedResponse3 = await fetch(new URL("/beta/value", address));
    expect(fetchedResponse3.status).toBe(404);
    expect(
      matchRoute(synchronization.current.client, "/beta/value"),
    ).toBeUndefined();
    expect(
      await Bun.file(join(typesDirectory, "beta/[id]/$types.d.ts")).exists(),
    ).toBe(false);
    expect(await Bun.file(unrelated).text()).toBe(
      "export type ApplicationOwned = true;\n",
    );
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.map(String)).toEqual(
      failures.map(() =>
        expect.stringContaining("Duplicate route parameter id"),
      ),
    );

    await synchronization.close();
    const count = publications.length;
    await Bun.write(join(routesDirectory, "+page.svelte"), "<h1>Closed</h1>");
    await quietFor(30);
    expect(publications).toHaveLength(count);
    await Bun.write(
      join(parent, "../evidence/c06-synchronization.json"),
      JSON.stringify(
        {
          bun: Bun.version,
          listener: address,
          operations: [
            "create",
            "rename",
            "invalid candidate retained",
            "repair",
            "delete",
            "close",
          ],
          publications: count,
          rejectedCandidates: failures.map(String),
          unrelatedDeclarationPreserved: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await synchronization.close();
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("C06: generated output cannot create a watcher feedback loop", async () => {
  expect(
    await throwingRejectionOf(
      synchronizeRoutes({
        routesDirectory: "/application/routes",
        typesDirectory: "/application/routes/generated",
        publish: () => {},
        onError: () => {},
      }),
    ),
  ).toThrow("outside the watched routes directory");
});

test("C06: a vanished route directory rescans, while a missing root still fails", async () => {
  const parent = join(import.meta.dir, "../../.velveteen/routing");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "synchronize-scan-"));
  const routesDirectory = join(directory, "routes");
  const errors: unknown[] = [];
  const options = {
    routesDirectory,
    typesDirectory: join(directory, "types"),
    publish: () => {},
    onError: (error: unknown) => errors.push(error),
  };
  await mkdir(routesDirectory);
  await Bun.write(join(routesDirectory, "+page.svelte"), "<h1>Retained</h1>");
  const nativeScan = Bun.Glob.prototype.scan;
  const scan = spyOn(Bun.Glob.prototype, "scan");
  const missing = (path: string) =>
    Object.assign(new Error("directory disappeared during scan"), {
      code: "ENOENT",
      path,
    });
  let recovered = false;
  let synchronization:
    Awaited<ReturnType<typeof synchronizeRoutes>> | undefined;
  try {
    scan
      .mockImplementationOnce(() => {
        throw missing("departed/nested");
      })
      .mockImplementationOnce(function (this: Bun.Glob, options) {
        recovered = true;
        return nativeScan.call(this, options);
      });
    synchronization = await synchronizeRoutes(options);
    expect(synchronization.current.manifest.routes.map(({ id }) => id)).toEqual(
      ["/"],
    );
    expect(recovered).toBe(true);
    expect(errors).toEqual([]);
    await synchronization.close();

    const missingRoot = missing(routesDirectory);
    scan.mockImplementationOnce(() => {
      throw missingRoot;
    });
    expect(await rejectionOf(synchronizeRoutes(options))).toBe(missingRoot);

    const secondFailure = missing("another/departed");
    scan
      .mockImplementationOnce(() => {
        throw missing("departed/nested");
      })
      .mockImplementationOnce(() => {
        throw secondFailure;
      });
    expect(await rejectionOf(synchronizeRoutes(options))).toBe(secondFailure);
  } finally {
    scan.mockRestore();
    await synchronization?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
