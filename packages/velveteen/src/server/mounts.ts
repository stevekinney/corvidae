import type {
  ApplicationOptions,
  FetchService,
  ServerRegistry,
} from "./types.ts";

type Mounted = {
  path: string;
  fetch: (request: Request) => Response | Promise<Response>;
  close?: () => void | Promise<void>;
};
const contains = (parent: string, child: string) =>
  child === parent || child.startsWith(`${parent}/`);
const canonicalSegment = (segment: string) => {
  const decoded = decodeURIComponent(segment);
  if (!decoded || decoded === "." || decoded === ".." || /[\\/]/.test(decoded))
    throw new TypeError("Invalid mount segment");
  return encodeURIComponent(decoded);
};
const canonicalPath = (path: string) =>
  path
    .split("/")
    .map((segment) => (segment ? canonicalSegment(segment) : ""))
    .join("/");

export function validateMounts(
  options: ApplicationOptions,
  registry: ServerRegistry,
  assets: Record<string, unknown>,
) {
  const entries = Object.keys(options.mounts ?? {}).map((key) => {
    if (!/^\/(?:[^/?#\\]+)(?:\/[^/?#\\]+)*$/.test(key))
      throw new TypeError(`Invalid mount path: ${key}`);
    try {
      return { key, path: canonicalPath(key) };
    } catch {
      throw new TypeError(`Invalid mount path: ${key}`);
    }
  });
  for (const [entryIndex, { path }] of entries.entries()) {
    if (
      entries.some(
        (other, otherIndex) =>
          otherIndex !== entryIndex &&
          (contains(path, other.path) || contains(other.path, path)),
      )
    )
      throw new Error(`Overlapping mount: ${path}`);
    if (
      ["/_remote", "/_assets"].some(
        (protectedPath) =>
          contains(path, protectedPath) || contains(protectedPath, path),
      )
    )
      throw new Error(`Protected mount path: ${path}`);
    const full = `${canonicalPath(options.generation.manifest.basePath)}${path}`;
    if (
      Object.keys(assets).some(
        (asset) =>
          contains(full, canonicalPath(asset)) ||
          contains(canonicalPath(asset), full),
      )
    )
      throw new Error(`Mount conflicts with asset: ${path}`);
    for (const route of registry.manifest.routes) {
      const segments = route.id
        .split("/")
        .filter(Boolean)
        .filter((segment) => !/^\(.*\)$/.test(segment));
      const mountSegments = path.split("/").filter(Boolean);
      const common = Math.min(segments.length, mountSegments.length);
      const overlaps = mountSegments
        .slice(0, common)
        .every(
          (segment, index) =>
            encodeURIComponent(segments[index]) === segment ||
            segments[index].includes("["),
        );
      if (
        overlaps &&
        (segments.length >= mountSegments.length ||
          segments.some((segment) => segment.includes("...")))
      )
        throw new Error(`Mount conflicts with route: ${route.id}`);
    }
  }
  return entries;
}

export async function startMounts(
  options: ApplicationOptions,
  paths: Array<{ key: string; path: string }>,
) {
  const mounts: Mounted[] = [];
  try {
    for (const { key, path } of paths) {
      const service: FetchService = await options.mounts![key]();
      mounts.push(
        typeof service === "function"
          ? { path, fetch: service }
          : {
              path,
              fetch: service.fetch.bind(service),
              close: service.close?.bind(service),
            },
      );
    }
  } catch (error) {
    await Promise.allSettled(mounts.map(async (mount) => mount.close?.()));
    throw error;
  }
  let closing: Promise<void> | undefined;
  const active = new Set<AbortController>();
  return {
    mounts,
    active,
    get closed() {
      return closing !== undefined;
    },
    close() {
      if (closing) return closing;
      const completion = Promise.withResolvers<void>();
      closing = completion.promise;
      for (const controller of active)
        controller.abort(
          new DOMException("Application disposed", "AbortError"),
        );
      void Promise.all(mounts.map(async (mount) => mount.close?.())).then(
        () => completion.resolve(),
        completion.reject,
      );
      return closing;
    },
  };
}

export function dispatchMount(
  mounts: Mounted[],
  base: string,
  request: Request,
  signal: AbortSignal,
  closed: boolean,
) {
  const url = new URL(request.url);
  const rawSegments = url.pathname.split("/");
  const mount = mounts.find(({ path }) => {
    const prefix = `${canonicalPath(base)}${path}`.split("/");
    if (rawSegments.length < prefix.length) return false;
    try {
      return prefix.every(
        (segment, index) =>
          !segment || canonicalSegment(rawSegments[index]) === segment,
      );
    } catch {
      return false;
    }
  });
  if (!mount) return undefined;
  if (closed) return new Response("Application disposed", { status: 503 });
  const prefixLength = `${base}${mount.path}`.split("/").length;
  url.pathname = `/${rawSegments.slice(prefixLength).join("/")}`;
  return mount.fetch(
    new Request(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal,
      redirect: request.redirect,
      credentials: request.credentials,
      duplex: "half",
    } as RequestInit),
  );
}
