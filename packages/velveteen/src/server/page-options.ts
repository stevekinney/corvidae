import type { ClientRouteEntry } from "../routing/manifest-types.ts";
import type { RuntimeRegistry } from "../data/contract.ts";

export type PageOptions = {
  prerender: boolean | "auto";
  ssr: boolean;
  csr: boolean;
  trailingSlash: "always" | "never" | "ignore";
};

const defaults: PageOptions = {
  prerender: false,
  ssr: true,
  csr: true,
  trailingSlash: "never",
};

const readModule = async (loader: (() => Promise<unknown>) | undefined) => {
  if (!loader) return {};
  const value: unknown = await loader();
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
};

const apply = (target: PageOptions, value: Record<string, unknown>) => {
  if ("prerender" in value) {
    if (![true, false, "auto"].includes(value.prerender as never))
      throw new TypeError("prerender must be true, false, or auto");
    target.prerender = value.prerender as PageOptions["prerender"];
  }
  for (const key of ["ssr", "csr"] as const)
    if (key in value) {
      if (typeof value[key] !== "boolean")
        throw new TypeError(`${key} must be a boolean`);
      target[key] = value[key];
    }
  if ("trailingSlash" in value) {
    if (!["always", "never", "ignore"].includes(value.trailingSlash as string))
      throw new TypeError("trailingSlash must be always, never, or ignore");
    target.trailingSlash = value.trailingSlash as PageOptions["trailingSlash"];
  }
};

/** Resolve inherited route options from universal and server route modules. */
export async function resolvePageOptions(
  registry: RuntimeRegistry,
  route: ClientRouteEntry,
): Promise<PageOptions & { entries?: unknown }> {
  const result: PageOptions & { entries?: unknown } = { ...defaults };
  let entries: unknown;
  for (const index of route.ancestors) {
    const [server, universal] = await Promise.all([
      readModule(registry.nodes[index].layoutServer),
      readModule(registry.nodes[index].layoutUniversal),
    ]);
    apply(result, server);
    apply(result, universal);
  }
  if (route.leaf !== undefined) {
    const [server, universal] = await Promise.all([
      readModule(registry.nodes[route.leaf].pageServer),
      readModule(registry.nodes[route.leaf].pageUniversal),
    ]);
    apply(result, server);
    apply(result, universal);
    if ("entries" in universal) entries = universal.entries;
    if ("entries" in server) entries = server.entries;
  } else {
    const endpoint = await readModule(registry.nodes[route.node].endpoint);
    apply(result, endpoint);
    if ("entries" in endpoint) entries = endpoint.entries;
  }
  if (entries !== undefined) result.entries = entries;
  return result;
}

/** Reject server actions, which need a live application, on static routes. */
export async function assertPrerenderable(
  registry: RuntimeRegistry,
  route: ClientRouteEntry,
): Promise<void> {
  if (route.leaf === undefined) return;
  const module = await readModule(registry.nodes[route.leaf].pageServer);
  if ("actions" in module)
    throw new Error(`Prerendered route ${route.id} cannot define actions`);
}
