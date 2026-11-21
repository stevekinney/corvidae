// The pinned implementation is an isolated oracle, never a candidate import or package dependency.
import { resolve } from "node:path";
import { assertCleanSource } from "./source-identity.ts";
const upstream = resolve(import.meta.dir, "upstream");
assertCleanSource(upstream, "a58e0a92c35dbeee161e96c733464dc7397e073a");
const input: unknown = JSON.parse(await Bun.stdin.text());
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}
if (
  input === null ||
  typeof input !== "object" ||
  !Object.hasOwn(input, "ids") ||
  !Object.hasOwn(input, "paths")
)
  throw new Error("Expected string route IDs and paths");
const { ids, paths } = input as { ids: unknown; paths: unknown };
if (!isStringArray(ids) || !isStringArray(paths))
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
  sort_routes(ids.map((id) => ({ id, ...parse_route_id(id) })));
console.log(
  JSON.stringify(
    paths.map((path) => {
      for (const route of routes) {
        const match = route.pattern.exec(decode_pathname(path));
        if (match)
          return { id: route.id, params: exec(match, route.params, {}) };
      }
      return null;
    }),
  ),
);
