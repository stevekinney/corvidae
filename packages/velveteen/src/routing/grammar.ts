import type { RouteParam } from "./manifest-types.ts";

/** A route diagnostic identifies the physical source and the offending path segment. */
export class RouteDiagnostic extends Error {
  constructor(
    readonly sourcePath: string,
    readonly routeId: string,
    readonly segment: string,
    readonly segmentIndex: number,
    message: string,
  ) {
    super(
      `${sourcePath}: route ${routeId}, segment ${segmentIndex + 1} (${segment}): ${message}`,
    );
    this.name = "RouteDiagnostic";
  }
}

export const urlSegments = (id: string) =>
  id
    .slice(1)
    .split("/")
    .filter((segment) => segment && !/^\([^)]+\)$/.test(segment));
const escape = (value: string) =>
  value
    .normalize()
    .split(/([%/?#])/)
    .map((part, index) => {
      if (index % 2)
        return (
          { "%": "%25", "/": "%2[Ff]", "?": "%3[Ff]", "#": "%23" } as Record<
            string,
            string
          >
        )[part];
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");

const escapeSequence = /^([ux])\+([^\]]+)$/;

export function decodeEscapeSequence(code: string): string {
  return String.fromCodePoint(Number.parseInt(code, 16));
}

export function encodePathnameCharacters(value: string): string {
  return value.replace(
    /[%/?#]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** Selected Kit grammar; unselected syntax is rejected instead of interpreted as literal text. */
export function parseRoute(
  id: string,
  sourcePath: string = id,
): { pattern: string; params: RouteParam[] } {
  const params: RouteParam[] = [];
  const names = new Set<string>();
  let previousRest = false;
  const sources: string[] = [];
  for (const [index, segment] of id.slice(1).split("/").entries()) {
    const fail = (message: string): never => {
      throw new RouteDiagnostic(sourcePath, id, segment, index, message);
    };
    if (!segment || /^\([^)]+\)$/.test(segment)) continue;
    if (/[()]/.test(segment)) fail("Unbalanced route group");
    const full =
      /^(?:\[\[([\w-]+)(?:=([\w-]+))?\]\]|\[\.\.\.([\w-]+)(?:=([\w-]+))?\])$/.exec(
        segment,
      );
    const add = (
      name: string,
      optional: boolean,
      rest: boolean,
      matcher: string | undefined,
      chained: boolean,
    ) => {
      if (names.has(name)) fail(`Duplicate route parameter ${name}`);
      names.add(name);
      params.push({ name, optional, rest, matcher, chained });
    };
    if (full) {
      const optional = !!full[1];
      const rest = !!full[3];
      if (optional && previousRest)
        fail("Optional parameter cannot immediately follow a rest parameter");
      add(full[1] || full[3], optional, rest, full[2] || full[4], true);
      sources.push(
        optional ? "(?:/([^/]+))?" : rest ? "(?:/([^]*))?" : "(?:/([^/]+?))",
      );
      previousRest = rest;
      continue;
    }
    previousRest = false;
    let cursor = 0;
    let source = "";
    let previousParameter = false;
    for (const token of segment.matchAll(/\[([^\]]+)\]/g)) {
      const literal = segment.slice(cursor, token.index);
      if (/[[\]]/.test(literal)) fail("Invalid or unbalanced parameter syntax");
      source += escape(literal);
      cursor = token.index + token[0].length;

      const sequence = escapeSequence.exec(token[1]);
      if (sequence) {
        const [, type, code] = sequence;
        const valid =
          type === "x"
            ? /^[0-9a-f]{2}$/.test(code)
            : /^[0-9a-f]{4,6}$/.test(code);
        if (!valid || Number.parseInt(code, 16) > 0x10ffff)
          fail("Invalid route escape sequence");
        source += escape(decodeEscapeSequence(code));
        previousParameter = false;
        continue;
      }

      const parameter = /^(\.\.\.)?([\w-]+)(?:=([\w-]+))?$/.exec(token[1]);
      if (!parameter) {
        fail("Invalid or unsupported parameter syntax");
        continue;
      }
      if (previousParameter && !literal)
        fail("Adjacent parameters require a static separator");
      const [, restMarker, name, matcher] = parameter;
      const rest = !!restMarker;
      source += rest ? "([^]*?)" : "([^/]+?)";
      add(name, false, rest, matcher, rest && token.index === 0);
      previousParameter = true;
    }
    const suffix = segment.slice(cursor);
    if (/[[\]]/.test(suffix)) fail("Invalid or unbalanced parameter syntax");
    source += escape(suffix);
    sources.push("/" + source);
  }
  return {
    pattern: sources.length ? `^${sources.join("")}/?$` : "^/$",
    params,
  };
}
