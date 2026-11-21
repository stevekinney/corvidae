import {
  decodeEscapeSequence,
  encodePathnameCharacters,
  urlSegments,
} from "./grammar.ts";

type Part = {
  type: "static" | "required" | "optional" | "rest";
  content: string;
  matched: boolean;
};
type Segment = Part[];
const EMPTY: Part = { type: "static", content: "", matched: false };
function routeSegments(route: string): string[] {
  return urlSegments(route.replace(/\[\[[^\]]+\]\](?!(?:\/\([^/]+\))*$)/g, ""));
}

function split(segment: string): Segment {
  const parts: Segment = [];
  let index = 0;
  let literal = "";
  while (index <= segment.length) {
    const start = segment.indexOf("[", index);
    if (start === -1) {
      parts.push({
        type: "static",
        content: literal + segment.slice(index),
        matched: false,
      });
      break;
    }
    literal += segment.slice(index, start);
    const type =
      segment[start + 1] === "["
        ? "optional"
        : segment[start + 1] === "."
          ? "rest"
          : "required";
    const delimiter = type === "optional" ? "]]" : "]";
    const end = segment.indexOf(delimiter, start);
    if (end === -1) throw new Error(`Invalid route ID ${segment}`);
    const content = segment.slice(start, (index = end + delimiter.length));
    const escaped = /^\[[ux]\+([0-9a-f]+)\]$/.exec(content);
    if (escaped) {
      literal += decodeEscapeSequence(escaped[1]);
      continue;
    }
    parts.push({ type: "static", content: literal, matched: false });
    literal = "";
    parts.push({ type, content, matched: content.includes("=") });
  }
  return parts;
}

function sortStatic(a: string, b: string): number {
  if (a === b) return 0;
  for (let index = 0; ; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left !== right) {
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return left < right ? -1 : 1;
    }
  }
}

/** Port of Kit's create_manifest_data/sort.js at a58e0a92c35dbeee161e96c733464dc7397e073a. */
export function sortRoutes<T extends { id: string }>(routes: T[]): T[] {
  const cache = new Map<string, Segment>();
  const getParts = (segment: string) => {
    const value = cache.get(segment) ?? split(segment);
    cache.set(segment, value);
    return value;
  };
  return routes.toSorted((left, right) => {
    const aSegments = routeSegments(left.id).map(getParts);
    const bSegments = routeSegments(right.id).map(getParts);
    for (let i = 0; i < Math.max(aSegments.length, bSegments.length); i += 1) {
      const aSegment = aSegments[i] ?? [EMPTY];
      const bSegment = bSegments[i] ?? [EMPTY];
      for (let j = 0; j < Math.max(aSegment.length, bSegment.length); j += 1) {
        const a = aSegment[j];
        const b = bSegment[j];
        const dynamic = j % 2 === 1;
        if (dynamic) {
          if (!a) return -1;
          if (!b) return 1;
          const nextA =
            aSegment[j + 1]?.content || aSegments[i + 1]?.[0].content;
          const nextB =
            bSegment[j + 1]?.content || bSegments[i + 1]?.[0].content;
          if (a.type === "rest" && b.type === "rest") {
            if (nextA && nextB) continue;
            if (nextA) return -1;
            if (nextB) return 1;
          }
          if (a.type === "rest") return nextA && !nextB ? -1 : 1;
          if (b.type === "rest") return nextB && !nextA ? 1 : -1;
          if (a.matched !== b.matched) return a.matched ? -1 : 1;
          if (a.type !== b.type) {
            if (a.type === "required") return -1;
            if (b.type === "required") return 1;
          }
        } else if (a.content !== b.content) {
          if (a === EMPTY) return -1;
          if (b === EMPTY) return 1;
          return sortStatic(a.content, b.content);
        }
      }
    }
    return left.id < right.id ? 1 : -1;
  });
}

function normalize(id: string): string {
  return (
    "/" +
    urlSegments(id)
      .map((segment) =>
        split(segment)
          .map((part) => {
            if (part.type === "static") {
              return encodePathnameCharacters(part.content.normalize())
                .replaceAll("<", "%3C")
                .replaceAll(">", "%3E");
            }
            const match = /=([\w-]+)\]+$/.exec(part.content)?.[1] ?? "*";
            const prefix =
              part.type === "optional"
                ? "?"
                : part.type === "rest"
                  ? "..."
                  : "";
            return `<${prefix}${match}>`;
          })
          .join(""),
      )
      .join("/")
  );
}

export class RouteConflict extends Error {
  constructor(
    readonly first: string,
    readonly second: string,
  ) {
    super(`Route conflict: ${first} and ${second}`);
    this.name = "RouteConflict";
  }
}

/** Port of Kit's create_manifest_data/conflict.js, retaining optional permutations. */
export function rejectConflicts(routes: { id: string }[]): void {
  const lookup = new Map<string, string>();
  for (const route of routes) {
    const normalized = normalize(route.id);
    let permutations: string[];
    if (
      !/<\?.+?>$/.test(normalized) &&
      [...normalized.matchAll(/<\?.+?>/g)].length
    ) {
      const pieces = normalized.split(/<\?(.+?)>/g);
      permutations = [pieces[0]];
      for (let index = 1; index < pieces.length; index += 2) {
        const matcher = pieces[index];
        const next = pieces[index + 1];
        permutations = permutations.reduce<string[]>((result, value) => {
          result.push(value + next);
          if (!(matcher === "*" && value.endsWith("//")))
            result.push(value + `<${matcher}>${next}`);
          return result;
        }, []);
      }
    } else permutations = [normalized];
    for (const permutation of permutations) {
      const key = permutation
        .replace(/\/{2,}/g, "/")
        .replace(/^\//, "")
        .replace(/\/$/, "");
      const previous = lookup.get(key);
      if (previous) throw new RouteConflict(previous, route.id);
      lookup.set(key, route.id);
    }
  }
}
