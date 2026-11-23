import { matchRoute } from "../routing/match.ts";
import { shouldRerun } from "../data/tracking.ts";
import type {
  RuntimeRegistry,
  ResolvedPage,
  Invalidation,
} from "../data/contract.ts";
export function selectServerLoads(
  registry: RuntimeRegistry,
  page: ResolvedPage,
  url: URL,
  base: string,
  invalidation?: Invalidation,
) {
  if (invalidation === "all") return undefined;
  const match = matchRoute(
    registry.manifest,
    url.pathname.slice(base.length) || "/",
    registry.matchers,
  );
  if (!match) return undefined;
  const next = {
    ...page.payload,
    url: url.href,
    params: match.params,
    routeId: match.route.id,
  };
  const keys: string[] = [];
  let parentChanged = false;
  const include = (node: number, role: "layout" | "page") => {
    const key = `${node}:${role}`,
      old = page.payload.nodes.find((item) => item.key === key);
    const changed: boolean =
      !old ||
      shouldRerun(old.uses, page.payload, next, invalidation, parentChanged);
    if (changed) keys.push(key);
    parentChanged ||= changed;
  };
  for (const node of match.route.layouts) {
    if (node !== null) include(node, "layout");
  }
  if (match.route.leaf !== undefined) include(match.route.leaf, "page");
  return keys;
}
