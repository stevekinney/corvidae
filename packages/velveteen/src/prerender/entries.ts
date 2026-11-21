import {
  decodeEscapeSequence,
  encodePathnameCharacters,
  urlSegments,
} from "../routing/grammar.ts";
import { matchRoute } from "../routing/match.ts";
import type {
  ClientRouteEntry,
  ClientRouteManifest,
  RouteMatchers,
} from "../routing/manifest-types.ts";
/** Expand the already-validated route grammar and verify the result with the canonical matcher. */
export function entryPath(
  routing: ClientRouteManifest,
  route: ClientRouteEntry,
  params: Record<string, string> = {},
  matchers?: RouteMatchers,
): string {
  for (const [key, value] of Object.entries(params))
    if (
      typeof value !== "string" ||
      !route.params.some((parameter) => parameter.name === key)
    )
      throw new TypeError(`Invalid entry parameter ${key}`);
  for (const parameter of route.params)
    if (!parameter.optional && !parameter.rest && !params[parameter.name])
      throw new TypeError(`Missing entry parameter ${parameter.name}`);
  const pathname =
    "/" +
    urlSegments(route.id)
      .map((segment) =>
        segment.replace(
          /\[[ux]\+([^\]]+)\]|\[\[([\w-]+)(?:=[\w-]+)?\]\]|\[\.\.\.([\w-]+)(?:=[\w-]+)?\]|\[([\w-]+)(?:=[\w-]+)?\]/g,
          (
            _token,
            escape: string,
            optional: string,
            rest: string,
            required: string,
          ) => {
            if (escape)
              return encodePathnameCharacters(decodeEscapeSequence(escape));
            const name = optional || rest || required;
            const value = Object.hasOwn(params, name) ? params[name] : "";
            return rest
              ? value.split("/").map(encodeURIComponent).join("/")
              : encodeURIComponent(value);
          },
        ),
      )
      .filter(Boolean)
      .join("/");
  const matched = matchRoute(routing, pathname, matchers);
  if (matched?.route.id !== route.id)
    throw new Error(`Entry does not match route ${route.id}`);
  for (const parameter of route.params) {
    const supplied = Object.hasOwn(params, parameter.name);
    if (
      parameter.optional &&
      supplied !== Object.hasOwn(matched.params, parameter.name)
    )
      throw new Error(`Entry changes route parameter ${parameter.name}`);
    if (
      !parameter.matcher &&
      supplied &&
      matched.params[parameter.name] !== params[parameter.name]
    )
      throw new Error(`Entry changes route parameter ${parameter.name}`);
  }
  return pathname;
}
export async function routeEntries(
  value: unknown,
): Promise<Record<string, string>[]> {
  if (value === undefined) return [];
  if (typeof value !== "function")
    throw new TypeError("entries must be a function");
  const entries: unknown = await value();
  if (
    !Array.isArray(entries) ||
    !entries.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.values(entry).every(
          (entryValue) => typeof entryValue === "string",
        ),
    )
  )
    throw new TypeError("entries() must return string parameter objects");
  return entries as Record<string, string>[];
}
