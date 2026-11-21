import type {
  Data,
  LoadNode,
  PagePayload,
  Route,
  RuntimeRegistry,
} from "../data/contract.ts";
import { emptyUses, trackLoad } from "../data/tracking.ts";
import { LoadFailure } from "../data/errors.ts";
import { loadOutput, type LoadObserver } from "../data/loads.ts";
import { resolvePageOptions } from "./page-options.ts";
import type { RequestEvent, ServerModule } from "./types.ts";

export async function preparePage(
  registry: RuntimeRegistry,
  route: Route,
  event: RequestEvent,
  basePath: string,
  stylesheets: string[],
) {
  const nodes: LoadNode[] = [];
  const branch: PagePayload["branch"] = [];
  for (const node of route.ancestors) {
    const entry = registry.nodes[node];
    if (entry.layout || entry.layoutServer || entry.layoutUniversal)
      nodes.push({
        key: `${node}:layout`,
        node,
        role: "layout",
        data: {},
        uses: emptyUses(),
      });
    if (entry.layout) branch.push({ node, role: "layout" });
  }
  if (route.leaf !== undefined) {
    nodes.push({
      key: `${route.leaf}:page`,
      node: route.leaf,
      role: "page",
      data: {},
      uses: emptyUses(),
    });
    branch.push({ node: route.leaf, role: "page" });
  }
  const modules = await Promise.all(
    nodes.map(async (node) => {
      const entry = registry.nodes[node.node];
      const server = (await entry[
        node.role === "layout" ? "layoutServer" : "pageServer"
      ]?.()) as ServerModule | undefined;
      const universal =
        await entry[
          node.role === "layout" ? "layoutUniversal" : "pageUniversal"
        ]?.();
      return { server, universal };
    }),
  );
  const { ssr, csr } = await resolvePageOptions(registry, route);
  const settings = { ssr, csr };
  const payload: PagePayload = {
    version: 1,
    url: event.url.href,
    basePath,
    stylesheets,
    routeId: route.id,
    params: event.params,
    status: 200,
    error: null,
    options: settings,
    nodes,
    branch,
    fetched: [],
  };
  return { payload, modules };
}
export async function runServerLoads(
  payload: PagePayload,
  modules: Awaited<ReturnType<typeof preparePage>>["modules"],
  event: RequestEvent,
  selection?: string[],
  observeLoad?: LoadObserver,
) {
  const pending = new Map<number, Promise<Data>>();
  const selected = selection ? new Set(selection) : undefined;
  if (
    selected &&
    [...selected].some((key) => !payload.nodes.some((node) => node.key === key))
  )
    throw new TypeError("Unknown load key");
  for (const node of payload.nodes)
    node.skip = selected ? !selected.has(node.key) : false;
  const run = (index: number): Promise<Data> => {
    const cached = pending.get(index);
    if (cached) return cached;
    const node = payload.nodes[index];
    node.skip = false;
    const promise = Promise.resolve().then(async () => {
      event.signal.throwIfAborted();
      const load = modules[index].server?.load;
      if (!load) return node.data;
      const tracked = trackLoad({
        ...event,
        data: {},
        parent: async () => {
          const results = await Promise.all(
            payload.nodes.slice(0, index).map((_, parent) => run(parent)),
          );
          return results.reduce(
            (result, data) => ({ ...result, ...data }),
            {} as Data,
          );
        },
        depends: () => {},
        untrack: (operation) => operation(),
      });
      try {
        const execute = async () =>
          loadOutput(await load({ ...event, ...tracked.event }));
        const data = await (observeLoad
          ? observeLoad(node.key, execute)
          : execute());
        event.signal.throwIfAborted();
        node.data = data;
        node.uses = tracked.uses;
        return node.data;
      } catch (cause) {
        event.signal.throwIfAborted();
        throw new LoadFailure(node.node, node.role, cause);
      }
    });
    pending.set(index, promise);
    return promise;
  };
  const settled = await Promise.allSettled(
    payload.nodes.map((node, index) =>
      node.skip ? Promise.resolve({}) : run(index),
    ),
  );
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}
