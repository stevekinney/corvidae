import type {
  PagePayload,
  ResolvedPage,
  RuntimeRegistry,
} from "../data/contract.ts";
import type { Prepared } from "./types.ts";

export function createPreloads(
  registry: RuntimeRegistry,
  input: {
    resolveUrl: (value: string | URL) => URL;
    inside: (url: URL) => boolean;
    disposed: () => boolean;
    read: (url: URL, controller: AbortController) => Promise<Prepared>;
    resolve: (prepared: Prepared) => Promise<ResolvedPage>;
  },
) {
  const preloads = new Map<
    string,
    { controller: AbortController; work: Promise<Prepared> }
  >();
  const clearPreloads = () => {
    for (const item of preloads.values())
      item.controller.abort(
        new DOMException("Preload invalidated", "AbortError"),
      );
    preloads.clear();
  };
  const preloadCode = async (id: string) => {
    const route = registry.manifest.routes.find(
      (candidate) => candidate.id === id,
    );
    if (!route) throw new Error(`Unknown route: ${id}`);
    const leaf =
      route.leaf === undefined ? undefined : registry.nodes[route.leaf];
    await Promise.all([
      ...route.ancestors.flatMap((index) => {
        const node = registry.nodes[index];
        return [node.layout?.(), node.layoutUniversal?.()];
      }),
      leaf?.page?.(),
      leaf?.pageUniversal?.(),
    ]);
  };
  const preloadData = async (
    value: string | URL,
  ): Promise<PagePayload | null> => {
    const url = input.resolveUrl(value);
    if (!input.inside(url) || input.disposed()) return null;
    let entry = preloads.get(url.href);
    if (!entry) {
      const controller = new AbortController();
      const work = input.read(url, controller).then(async (prepared) => {
        if (!prepared.payload.redirect && prepared.payload.status < 400)
          prepared.resolved = await input.resolve(prepared);
        return prepared;
      });
      entry = { controller, work };
      preloads.set(url.href, entry);
    }
    try {
      const prepared = await entry.work;
      if (prepared.payload.status >= 400) {
        preloads.delete(url.href);
        entry.controller.abort();
        return null;
      }
      return prepared.payload;
    } catch (error) {
      preloads.delete(url.href);
      entry.controller.abort(error);
      return null;
    }
  };
  return {
    clear: clearPreloads,
    preloadCode,
    preloadData,
    take(url: URL) {
      const entry = preloads.get(url.href);
      if (entry) preloads.delete(url.href);
      return entry;
    },
  };
}
