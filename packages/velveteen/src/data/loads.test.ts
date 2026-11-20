import {
  rejectionOf,
  throwingRejectionOf,
} from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import type { PagePayload, RuntimeRegistry } from "./contract.ts";
import {
  runUniversalLoads,
  emptyUses,
  shouldRerun,
  trackLoad,
} from "./loads.ts";
import { LoadFailure, createErrorPayload } from "./errors.ts";
import { assertRegistryPayload } from "./validate.ts";
import { selectServerLoads } from "../client/load-selection.ts";
const payload = (url = "https://app.test/items/one?x=1"): PagePayload => ({
  version: 1,
  url,
  basePath: "",
  stylesheets: [],
  routeId: "/items/[id]",
  params: { id: "one" },
  status: 200,
  error: null,
  options: { ssr: true, csr: true },
  nodes: [
    {
      key: "0:layout",
      node: 0,
      role: "layout",
      data: { server: 1 },
      uses: emptyUses(),
    },
    {
      key: "1:page",
      node: 1,
      role: "page",
      data: { server: 2 },
      uses: emptyUses(),
    },
  ],
  branch: [],
  fetched: [],
});
const registry = (nodes: RuntimeRegistry["nodes"]): RuntimeRegistry => ({
  nodes,
  manifest: {
    version: 1,
    nodes: [],
    routes: [
      {
        id: "/items/[id]",
        pattern: "",
        params: [],
        node: 1,
        leaf: 1,
        ancestors: [0, 1],
        layouts: [0, null],
        errors: [null, null],
      },
    ],
  },
});
const options = () => ({
  fetch: globalThis.fetch,
  signal: new AbortController().signal,
});

test("E01: universal loads start concurrently, parent waits, and own server data remains separate", async () => {
  const release = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>();
  const modules = registry([
    {
      layoutUniversal: async () => ({
        load: async ({ data }) => {
          await release.promise;
          return { parent: 3, server: data.server };
        },
      }),
    },
    {
      pageUniversal: async () => ({
        load: async ({ data, parent }) => {
          started.resolve();
          return { ...(await parent()), own: data.server };
        },
      }),
    },
  ]);
  const pending = runUniversalLoads(modules, payload(), options());
  await started.promise;
  release.resolve();
  const page = await pending;
  expect(page.loads.map((load) => load.data)).toEqual([
    { parent: 3, server: 1 },
    { parent: 3, server: 1, own: 2 },
  ]);
  expect(page.loads[1].uses.parent).toBe(true);
});

test("F02: tracking isolates search parameters, parent dependencies and explicit invalidations", async () => {
  let parentRuns = 0,
    childRuns = 0;
  const modules = registry([
    {
      layoutUniversal: async () => ({
        load: ({ url, depends }) => {
          depends("app:data");
          return { count: ++parentRuns, x: url.searchParams.get("x") };
        },
      }),
    },
    {
      pageUniversal: async () => ({
        load: async ({ parent }) => ({
          child: ++childRuns,
          ...(await parent()),
        }),
      }),
    },
  ]);
  const first = await runUniversalLoads(modules, payload(), options());
  const next = payload("https://app.test/items/one?x=1&unused=2");
  next.nodes.forEach((node) => (node.skip = true));
  const reused = await runUniversalLoads(modules, next, {
    ...options(),
    previous: first,
  });
  expect([parentRuns, childRuns]).toEqual([1, 1]);
  const changed = payload("https://app.test/items/one?x=2");
  changed.nodes.forEach((node) => (node.skip = true));
  const updated = await runUniversalLoads(modules, changed, {
    ...options(),
    previous: reused,
  });
  expect([parentRuns, childRuns]).toEqual([2, 2]);
  await runUniversalLoads(modules, changed, {
    ...options(),
    previous: updated,
    invalidation: ["app:data"],
  });
  expect([parentRuns, childRuns]).toEqual([3, 3]);
  expect(
    shouldRerun({ ...emptyUses(), params: ["id"] }, payload(), {
      ...payload(),
      params: { id: "two" },
    }),
  ).toBe(true);
});

test("E01: malformed load returns and child failures retain successful ancestor results", async () => {
  const modules = registry([
    { layoutUniversal: async () => ({ load: () => ({ parent: true }) }) },
    {
      pageUniversal: async () => ({
        load: () => {
          throw new Error("child");
        },
      }),
    },
  ]);
  try {
    await runUniversalLoads(modules, payload(), options());
    throw Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(LoadFailure);
    expect((error as LoadFailure).partial.map((load) => load.data)).toEqual([
      { parent: true },
    ]);
  }
  const base = {
    url: new URL("https://app.test/?x=1"),
    params: { id: "one" },
    route: { id: "/" },
    data: {},
    fetch: globalThis.fetch,
    parent: async () => ({}),
    depends: () => {},
    untrack: <T>(operation: () => T) => operation(),
    setHeaders: () => {},
    signal: new AbortController().signal,
  };
  const tracked = trackLoad(base);
  tracked.event.untrack(() => tracked.event.params.id);
  expect(tracked.uses.params).toEqual([]);
  expect(() => tracked.event.url.hash).toThrow("URL.hash");
  const routing: RuntimeRegistry["manifest"] = {
    version: 1,
    nodes: [],
    routes: [
      {
        id: "/items/[id]",
        pattern: "",
        params: [],
        node: 1,
        leaf: 1,
        ancestors: [0, 1],
        layouts: [0, 1],
        errors: [0, 1],
      },
    ],
  };
  const failed = createErrorPayload(
    {
      ...payload(),
      branch: [
        { node: 0, role: "layout" },
        { node: 1, role: "layout" },
        { node: 1, role: "page" },
      ],
    },
    routing,
    500,
    { message: "Internal Error" },
    { node: 1, role: "layout" },
  );
  expect(failed.branch).toEqual([
    { node: 0, role: "layout" },
    { node: 0, role: "error" },
  ]);
});

test("L: tracking all route parameters compares typed values without stringification", () => {
  const current = {
    ...payload(),
    params: { id: 9007199254740993n, enabled: false, quantity: 0 },
  };
  const uses = { ...emptyUses(), params: ["*"] };
  expect(
    shouldRerun(uses, current, {
      ...current,
      params: { quantity: 0, enabled: false, id: 9007199254740993n },
    }),
  ).toBe(false);
  expect(
    shouldRerun(uses, current, {
      ...current,
      params: { ...current.params, id: 9007199254740994n },
    }),
  ).toBe(true);
  expect(
    shouldRerun(uses, current, {
      ...current,
      params: { ...current.params, id: "9007199254740993" },
    }),
  ).toBe(true);
});

test("L: reusing server data preserves its tracked parameters for the next navigation", async () => {
  const modules = registry([{}, {}]);
  const route = modules.manifest.routes[0];
  route.pattern = "^/items/([^/]+)$";
  route.params = [
    { name: "id", matcher: "integer", optional: false, rest: false },
  ];
  modules.matchers = { integer: Number };
  const initial = { ...payload("https://app.test/items/0"), params: { id: 0 } };
  initial.nodes[1].uses.params.push("*");
  const previous = await runUniversalLoads(modules, initial, options());
  const same = payload("https://app.test/items/00");
  same.nodes.forEach((node) => {
    node.skip = true;
    node.data = {};
  });
  const reused = await runUniversalLoads(
    modules,
    { ...same, params: { id: 0 } },
    {
      ...options(),
      previous,
    },
  );
  expect(reused.payload.nodes[1].data).toEqual({ server: 2 });
  expect(
    selectServerLoads(modules, reused, new URL("https://app.test/items/1"), ""),
  ).toEqual(["1:page"]);
});

test("EF01: unknown load/render roles are rejected before module execution", async () => {
  const modules = registry([{}, {}]);
  const invalid = payload();
  invalid.nodes[1].node = 99;
  invalid.nodes[1].key = "99:page";
  expect(
    await throwingRejectionOf(runUniversalLoads(modules, invalid, options())),
  ).toThrow("Unknown load node");
  expect(
    await throwingRejectionOf(
      runUniversalLoads(
        modules,
        { ...payload(), branch: [{ node: 3, role: "page" }] },
        options(),
      ),
    ),
  ).toThrow("Invalid render branch");
  expect(
    await throwingRejectionOf(
      runUniversalLoads(
        modules,
        { ...payload(), branch: [{ node: 1, role: "page" }] },
        options(),
      ),
    ),
  ).toThrow("Unknown render role");
});

test("K: a reset page is selected and validated outside its effective layout branch", () => {
  const modules = registry([
    { layoutServer: async () => ({}) },
    { page: async () => ({ default: () => ({}) }) },
  ]);
  const route = modules.manifest.routes[0];
  route.pattern = "^/items/([^/]+)$";
  route.params = [{ name: "id", optional: false, rest: false }];
  route.ancestors = [0];
  route.layouts = [0];
  route.errors = [0];
  const current = payload();
  current.nodes[1].uses.params = ["id"];
  current.branch = [{ node: 1, role: "page" }];
  expect(() => assertRegistryPayload(current, modules)).not.toThrow();
  expect(() =>
    assertRegistryPayload(
      { ...current, branch: [...current.branch, ...current.branch] },
      modules,
    ),
  ).toThrow("Invalid render branch order");
  expect(() =>
    assertRegistryPayload(
      {
        ...current,
        nodes: [
          ...current.nodes,
          { ...current.nodes[0], node: 1, key: "1:layout" },
        ],
      },
      modules,
    ),
  ).toThrow("Unknown load node");
  expect(
    selectServerLoads(
      modules,
      { payload: current, branch: [], loads: [] },
      new URL("https://app.test/items/two"),
      "",
    ),
  ).toEqual(["1:page"]);
  expect(
    createErrorPayload(
      current,
      modules.manifest,
      418,
      { message: "failure" },
      { node: 1, role: "page" },
    ).branch,
  ).toEqual([{ node: 0, role: "error" }]);
});

test("F03: abort releases a load coordinator even when application work ignores its signal", async () => {
  const controller = new AbortController(),
    started = Promise.withResolvers<void>();
  const modules = registry([
    {
      layoutUniversal: async () => ({
        load: () => {
          started.resolve();
          return new Promise(() => {});
        },
      }),
    },
    {},
  ]);
  const work = runUniversalLoads(modules, payload(), {
    ...options(),
    signal: controller.signal,
  });
  await started.promise;
  const reason = new DOMException("Superseded", "AbortError");
  controller.abort(reason);
  expect(await rejectionOf(work)).toBe(reason);
});
