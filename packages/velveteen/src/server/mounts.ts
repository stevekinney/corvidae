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

export function validateMounts(
  options: ApplicationOptions,
  registry: ServerRegistry,
  assets: Record<string, unknown>,
) {
  const paths = Object.keys(options.mounts ?? {});
  for (const path of paths) {
    if (
      !/^\/(?:[^/%?#]+)(?:\/[^/%?#]+)*$/.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")
    )
      throw new TypeError(`Invalid mount path: ${path}`);
    if (
      paths.some(
        (other) =>
          other !== path && (contains(path, other) || contains(other, path)),
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
    const full = `${options.generation.manifest.basePath}${path}`;
    if (
      Object.keys(assets).some(
        (asset) => contains(full, asset) || contains(asset, full),
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
            segments[index] === segment || segments[index].includes("["),
        );
      if (
        overlaps &&
        (segments.length >= mountSegments.length ||
          segments.some((segment) => segment.includes("...")))
      )
        throw new Error(`Mount conflicts with route: ${route.id}`);
    }
  }
  return paths;
}

export async function startMounts(
  options: ApplicationOptions,
  paths: string[],
) {
  const mounts: Mounted[] = [];
  try {
    for (const path of paths) {
      const service: FetchService = await options.mounts![path]();
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
  const mount = mounts.find(({ path }) =>
    contains(`${base}${path}`, url.pathname),
  );
  if (!mount) return undefined;
  if (closed) return new Response("Application disposed", { status: 503 });
  url.pathname = url.pathname.slice((base + mount.path).length) || "/";
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
