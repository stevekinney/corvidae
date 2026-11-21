import type {
  Invalidation,
  PagePayload,
  UniversalLoadEvent,
  Uses,
} from "./contract.ts";

export const emptyUses = (): Uses => ({
  params: [],
  search: [],
  url: [],
  dependencies: [],
  parent: false,
  route: false,
});
/** Track public load inputs while preserving native URL methods and selective query dependencies. */
export function trackLoad(input: UniversalLoadEvent): {
  event: UniversalLoadEvent;
  uses: Uses;
} {
  const uses = emptyUses();
  let tracking = true;
  const add = (
    field: "params" | "search" | "url" | "dependencies",
    name: string,
  ) => {
    if (tracking && !uses[field].includes(name)) uses[field].push(name);
  };
  const search = new Proxy(input.url.searchParams, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (["get", "getAll", "has"].includes(String(key)))
        return (name: string, ...rest: string[]) => {
          add("search", name);
          return Reflect.apply(value, target, [name, ...rest]);
        };
      add("url", "search");
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const url = new Proxy(input.url, {
    get(target, key) {
      if (key === "hash")
        throw new Error("Load functions cannot depend on URL.hash");
      if (key === "searchParams") return search;
      const value = Reflect.get(target, key, target);
      if (typeof key === "string" && typeof value !== "function")
        add("url", key);
      if (typeof value === "function")
        return (...args: unknown[]) => {
          add("url", "href");
          return Reflect.apply(value, target, args);
        };
      return value;
    },
  });
  const params = new Proxy(input.params, {
    get(target, key) {
      if (typeof key === "string") add("params", key);
      return Reflect.get(target, key);
    },
    ownKeys(target) {
      add("params", "*");
      return Reflect.ownKeys(target);
    },
    has(target, key) {
      if (typeof key === "string") add("params", key);
      return Reflect.has(target, key);
    },
  });
  const route = new Proxy(input.route, {
    get(target, key) {
      if (tracking) uses.route = true;
      return Reflect.get(target, key);
    },
  });
  return {
    uses,
    event: {
      ...input,
      url,
      params,
      route,
      parent: () => {
        if (tracking) uses.parent = true;
        return input.parent();
      },
      depends: (...values) => {
        for (const value of values)
          add("dependencies", new URL(value, input.url).href);
      },
      untrack: (operation) => {
        const previous = tracking;
        tracking = false;
        try {
          return operation();
        } finally {
          tracking = previous;
        }
      },
    },
  };
}
/** Decide reuse from observed inputs rather than route-file identity alone. */
export function shouldRerun(
  uses: Uses,
  previous: PagePayload,
  next: PagePayload,
  invalidation?: Invalidation,
  parentChanged = false,
): boolean {
  if (
    invalidation === "all" ||
    (uses.parent && parentChanged) ||
    (uses.route && previous.routeId !== next.routeId)
  )
    return true;
  for (const name of uses.params)
    if (
      name === "*"
        ? Object.keys(previous.params).length !==
            Object.keys(next.params).length ||
          Object.keys(previous.params).some(
            (key) =>
              !Object.hasOwn(next.params, key) ||
              !Object.is(previous.params[key], next.params[key]),
          )
        : previous.params[name] !== next.params[name]
    )
      return true;
  const before = new URL(previous.url),
    after = new URL(next.url);
  for (const key of uses.url)
    if (Reflect.get(before, key, before) !== Reflect.get(after, key, after))
      return true;
  for (const key of uses.search)
    if (
      JSON.stringify(before.searchParams.getAll(key)) !==
      JSON.stringify(after.searchParams.getAll(key))
    )
      return true;
  return uses.dependencies.some((dependency) =>
    typeof invalidation === "function"
      ? invalidation(new URL(dependency))
      : invalidation?.includes(dependency),
  );
}
