// The pinned implementation is an isolated oracle, never a candidate import or package dependency.
import { resolve } from "node:path";
import { assertCleanSource } from "./source-identity.ts";
const upstream = resolve(import.meta.dir, "upstream");
assertCleanSource(upstream, "a58e0a92c35dbeee161e96c733464dc7397e073a");
const input: unknown = JSON.parse(await Bun.stdin.text());
if (
  !input ||
  typeof input !== "object" ||
  !("ids" in input) ||
  !("paths" in input) ||
  !Array.isArray(input.ids) ||
  !Array.isArray(input.paths) ||
  !input.ids.every((id) => typeof id === "string") ||
  !input.paths.every((path) => typeof path === "string")
)
  throw new Error("Expected string route IDs and paths");
const { parse_route_id, exec } = await import(
  `${upstream}/packages/kit/src/utils/routing.js`
);
const { decode_pathname } = await import(
  `${upstream}/packages/kit/src/utils/url.js`
);
const { sort_routes } = await import(
  `${upstream}/packages/kit/src/core/sync/create_manifest_data/sort.js`
);
const routes: Array<{ id: string; pattern: RegExp; params: unknown[] }> =
  sort_routes(input.ids.map((id: string) => ({ id, ...parse_route_id(id) })));
console.log(
  JSON.stringify(
    input.paths.map((path: string) => {
      for (const route of routes) {
        const match = route.pattern.exec(decode_pathname(path));
        if (match)
          return { id: route.id, params: exec(match, route.params, {}) };
      }
      return null;
    }),
  ),
);
