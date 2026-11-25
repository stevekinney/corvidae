import type {
  ApplicationOptions,
  FetchService,
  ServerRegistry,
} from "./types.ts";

type Mounted = {
  path: string;
  root: boolean;
  machineFormPaths: readonly string[];
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
  const base = canonicalPath(options.generation.manifest.basePath);
  const entries = Object.entries(options.mounts ?? {}).flatMap(
    ([key, declaration]) => {
      const paths = [
        { path: key, root: false },
        ...(typeof declaration === "function"
          ? []
          : declaration.rootPaths(base).map((path) => ({ path, root: true }))),
      ];
      return paths.map(({ path, root }) => {
        if (!/^\/(?:[^/?#\\]+)(?:\/[^/?#\\]+)*$/.test(path))
          throw new TypeError(`Invalid mount path: ${path}`);
        try {
          return { key, path: canonicalPath(path), root };
        } catch {
          throw new TypeError(`Invalid mount path: ${path}`);
        }
      });
    },
  );
  for (const [entryIndex, { path, root }] of entries.entries()) {
    const full = `${root ? "" : base}${path}`;
    if (
      entries.some(
        (other, otherIndex) =>
          otherIndex !== entryIndex &&
          (contains(full, `${other.root ? "" : base}${other.path}`) ||
            contains(`${other.root ? "" : base}${other.path}`, full)),
      )
    )
      throw new Error(`Overlapping mount: ${path}`);
    if (
      ["/_remote", "/_assets"].some(
        (protectedPath) =>
          contains(full, `${base}${protectedPath}`) ||
          contains(`${base}${protectedPath}`, full),
      )
    )
      throw new Error(`Protected mount path: ${path}`);
    if (
      Object.keys(assets).some(
        (asset) =>
          contains(full, canonicalPath(asset)) ||
          contains(canonicalPath(asset), full),
      )
    )
      throw new Error(`Mount conflicts with asset: ${path}`);
    for (const route of registry.manifest.routes) {
      if (root && base && !contains(base, path)) continue;
      const routePath = root ? path.slice(base.length) : path;
      const segments = route.id
        .split("/")
        .filter(Boolean)
        .filter((segment) => !/^\(.*\)$/.test(segment));
      const mountSegments = routePath.split("/").filter(Boolean);
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
  const machinePaths = new Map<string, readonly string[]>();
  for (const [key, declaration] of Object.entries(options.mounts ?? {})) {
    const requested =
      typeof declaration === "function"
        ? []
        : (declaration.machineFormPaths?.(base) ?? []);
    machinePaths.set(
      key,
      requested.map((path) => {
        if (!/^\/(?:[^/?#\\]+)(?:\/[^/?#\\]+)*$/.test(path))
          throw new TypeError(`Invalid machine form path: ${path}`);
        return canonicalPath(path);
      }),
    );
  }
  return entries.map((entry) => {
    const machineFormPaths = machinePaths.get(entry.key)!.map((canonical) => {
      const owner = entries.find((candidate) => {
        const full = `${candidate.root ? "" : base}${candidate.path}`;
        return candidate.root ? canonical === full : contains(full, canonical);
      });
      if (!owner || owner.key !== entry.key)
        throw new TypeError(
          `Machine form path is not owned by mount: ${canonical}`,
        );
      return { canonical, owner };
    });
    return {
      ...entry,
      machineFormPaths: machineFormPaths
        .filter(({ owner }) => owner === entry)
        .map(({ canonical }) => canonical),
    };
  });
}

export async function startMounts(
  options: ApplicationOptions,
  paths: Array<{
    key: string;
    path: string;
    root: boolean;
    machineFormPaths: readonly string[];
  }>,
) {
  const mounts: Mounted[] = [];
  const services = new Map<string, FetchService>();
  try {
    for (const { key, path, root, machineFormPaths } of paths) {
      let service = services.get(key);
      if (!service) {
        const declaration = options.mounts![key];
        service = await (typeof declaration === "function"
          ? declaration()
          : declaration.start(options.generation.manifest.basePath));
        services.set(key, service);
      }
      mounts.push(
        typeof service === "function"
          ? { path, root, machineFormPaths, fetch: service }
          : {
              path,
              root,
              machineFormPaths,
              fetch: service.fetch.bind(service),
              close: root ? undefined : service.close?.bind(service),
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
  const mount = mounts.find(({ path, root }) => {
    const prefix = `${root ? "" : canonicalPath(base)}${path}`.split("/");
    if (root && rawSegments.length !== prefix.length) return false;
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
  if (!mount.root) {
    const prefixLength = `${base}${mount.path}`.split("/").length;
    url.pathname = `/${rawSegments.slice(prefixLength).join("/")}`;
  }
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
