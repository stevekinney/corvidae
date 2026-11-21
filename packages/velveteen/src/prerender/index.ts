import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, realpath, readdir, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createApplication } from "../server/index.ts";
import {
  assertPrerenderable,
  resolvePageOptions,
  type PageOptions,
} from "../server/page-options.ts";
import { productionFilePath, canonicalAssetUrl } from "../build/paths.ts";
import type { ProductionGeneration } from "../build/manifest-types.ts";
import type { ServerRegistry } from "../server/types.ts";
import { matchRoute } from "../routing/match.ts";
import { dataMediaType } from "../data/contract.ts";
import { entryPath, routeEntries } from "./entries.ts";
import { serviceWorkerVersion } from "./service-worker.ts";
type StaticResponse = {
  status: number;
  headers: Record<string, string>;
  file: string;
  url: string;
  sha256: string;
  dataFile?: string;
  dataSha256?: string;
};
export type StaticManifest = {
  version: 1;
  basePath: string;
  responses: StaticResponse[];
};
export type PrerenderOptions = {
  generation: ProductionGeneration;
  outputDirectory: string;
  entries?: Array<string | { route: string; params?: Record<string, string> }>;
  origin?: string;
  hooks?: Parameters<typeof createApplication>[0]["hooks"];
  template?: string;
};
export type PrerenderResult = {
  directory: string;
  manifest: StaticManifest;
  version: string;
};
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const isHtml = (response: Response) =>
  response.headers.get("content-type")?.split(";")[0] === "text/html";
function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep))
  );
}
async function destination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await destination(parent), relative(parent, path));
  }
}
function filePath(pathname: string, html: boolean, redirect: boolean) {
  if (redirect) return `_redirects/${hash(pathname)}.txt`;
  if (!html) return pathname.slice(1) || "index";
  if (pathname.endsWith("/")) return `${pathname.slice(1)}index.html`;
  return `${pathname.slice(1) || "index"}.html`;
}
/** Render immutable public artifacts using the same request handler and canonical route matcher. */
export async function prerender(
  options: PrerenderOptions,
): Promise<PrerenderResult> {
  const { generation } = options;
  const base = generation.manifest.basePath,
    routing = generation.manifest.routing;
  const origin = new URL(options.origin ?? "http://velveteen.invalid").origin;
  if (!/^https?:/.test(origin))
    throw new TypeError("Prerender origin must use HTTP(S)");
  const output = await destination(resolve(options.outputDirectory));
  const generationDirectory = await realpath(generation.directory);
  if (
    contains(output, generationDirectory) ||
    contains(generationDirectory, output)
  )
    throw new Error(
      "Static output and production generation must not contain one another",
    );
  await mkdir(output, { recursive: true });
  const existing = await readdir(output);
  if (existing.includes("generations")) {
    const generations = await lstat(join(output, "generations"));
    if (!generations.isDirectory())
      throw new Error("Static generations must be a real directory");
  }
  if (
    existing.some(
      (name) =>
        name !== "generations" &&
        name !== "current.json" &&
        !name.startsWith(".stage-") &&
        !name.startsWith(".current-"),
    )
  )
    throw new Error("Refusing to replace an unowned static output directory");
  const id = randomUUID(),
    stage = join(output, `.stage-${id}`);
  const registry = (await import(
    join(generation.directory, generation.manifest.server.file)
  )) as ServerRegistry;
  const app = await createApplication({
    generation,
    registry,
    hooks: options.hooks,
    template: options.template,
    prerendering: true,
  });
  const records = new Map<string, StaticResponse>(),
    files = new Set<string>();
  const settings = new Map<string, PageOptions & { entries?: unknown }>(),
    visitedRoutes = new Set<string>();
  const queue: URL[] = [],
    queued = new Set<string>();
  const add = (value: string, parent = origin, explicit = false) => {
    const rawPath = value.split(/[?#]/)[0];
    if (
      explicit &&
      (rawPath.includes("\\") ||
        rawPath.split("/").some((segment) => {
          try {
            return [".", ".."].includes(decodeURIComponent(segment));
          } catch {
            return true;
          }
        }))
    )
      throw new Error("Unsafe prerender path");
    const url = new URL(value, parent);
    url.hash = "";
    if (
      url.origin !== origin ||
      !(url.pathname === base || url.pathname.startsWith(`${base}/`))
    ) {
      if (explicit)
        throw new Error("Prerender entry is outside application base");
      return;
    }
    if (url.search)
      throw new Error("Prerender entries cannot depend on a query string");
    if (!queued.has(url.pathname)) {
      queued.add(url.pathname);
      queue.push(url);
    }
  };
  const write = async (file: string, bytes: Uint8Array) => {
    const target = productionFilePath(stage, file);
    if (files.has(file)) throw new Error(`static output collision: ${file}`);
    files.add(file);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, bytes);
  };
  try {
    await mkdir(stage, { recursive: true });
    for (const asset of generation.manifest.assets) {
      const url = canonicalAssetUrl(base, asset);
      if (url !== asset.url) throw new Error("Invalid production asset URL");
      const bytes = new Uint8Array(
        await Bun.file(
          productionFilePath(generation.directory, asset.file),
        ).arrayBuffer(),
      );
      if (hash(bytes) !== asset.sha256)
        throw new Error("Production asset integrity mismatch");
      const file = url.slice(1);
      await write(file, bytes);
      records.set(url, {
        url: new URL(url, origin).href,
        file,
        sha256: asset.sha256,
        status: 200,
        headers: {
          "content-type": asset.contentType,
          "cache-control": asset.immutable
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }
    for (const route of routing.routes) {
      const setting = await resolvePageOptions(registry, route);
      settings.set(route.id, setting);
      if (setting.prerender === false) continue;
      await assertPrerenderable(registry, route);
      if (!route.params.length)
        add(`${base}${entryPath(routing, route)}`, origin, true);
      for (const params of await routeEntries(setting.entries))
        add(
          `${base}${entryPath(routing, route, params, registry.matchers)}`,
          origin,
          true,
        );
    }
    for (const entry of options.entries ?? []) {
      if (typeof entry === "string") add(entry, origin, true);
      else {
        const route = routing.routes.find(
          (candidate) => candidate.id === entry.route,
        );
        if (!route) throw new Error(`Unknown prerender route ${entry.route}`);
        add(
          `${base}${entryPath(routing, route, entry.params, registry.matchers)}`,
          origin,
          true,
        );
      }
    }
    while (queue.length) {
      const url = queue.shift()!;
      if (records.has(url.pathname)) continue;
      const matched = matchRoute(
        routing,
        url.pathname.slice(base.length) || "/",
        registry.matchers,
      );
      if (!matched)
        throw new Error(
          `prerender URL does not match a route: ${url.pathname}`,
        );
      const setting = settings.get(matched.route.id)!;
      if (setting.prerender === false) continue;
      const response = await app.fetch(
        new Request(url, { headers: { accept: "text/html" } }),
      );
      if (response.status < 200 || response.status >= 400)
        throw new Error(
          `Prerender failed: ${url.pathname} returned ${response.status}`,
        );
      if (response.headers.has("set-cookie"))
        throw new Error(`Prerender cannot publish cookies: ${url.pathname}`);
      const redirect = response.status >= 300;
      const headers = new Headers(response.headers);
      if (redirect) {
        const location = headers.get("location");
        if (!location) throw new Error("Prerender redirect needs Location");
        const target = new URL(location, url);
        if (!["http:", "https:"].includes(target.protocol))
          throw new Error("Invalid prerender redirect");
        if (target.origin === origin) {
          headers.set(
            "location",
            target.pathname + target.search + target.hash,
          );
          add(target.href, url.href);
        }
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const file = filePath(url.pathname, isHtml(response), redirect);
      await write(file, bytes);
      const record: StaticResponse = {
        url: url.href,
        file,
        sha256: hash(bytes),
        status: response.status,
        headers: Object.fromEntries(headers),
      };
      visitedRoutes.add(matched.route.id);
      if (isHtml(response) && !redirect) {
        const data = await app.fetch(
          new Request(url, { headers: { accept: dataMediaType } }),
        );
        const body = new Uint8Array(await data.arrayBuffer());
        if (
          data.status !== 200 ||
          data.headers.get("content-type")?.split(";")[0] !== dataMediaType
        )
          throw new Error("Invalid prerender data response");
        record.dataFile = `_page-data/${hash(url.pathname)}.txt`;
        record.dataSha256 = hash(body);
        await write(record.dataFile, body);
        const document = new Response(bytes, { headers });
        await new HTMLRewriter()
          .on("a[href]", {
            element(element) {
              const href = element.getAttribute("href");
              if (href) add(href, url.href);
            },
          })
          .transform(document)
          .arrayBuffer();
      }
      records.set(url.pathname, record);
    }
    for (const route of routing.routes)
      if (
        settings.get(route.id)?.prerender === true &&
        !visitedRoutes.has(route.id)
      )
        throw new Error(`missing prerender entry for ${route.id}`);
    const manifest: StaticManifest = {
      version: 1,
      basePath: base,
      responses: [...records.values()].toSorted((a, b) =>
        a.url.localeCompare(b.url),
      ),
    };
    const identities = manifest.responses.flatMap((record) => [
      { url: new URL(record.url).pathname, sha256: record.sha256 },
      ...(record.dataSha256
        ? [
            {
              url: `${new URL(record.url).pathname}#data`,
              sha256: record.dataSha256,
            },
          ]
        : []),
    ]);
    const version = serviceWorkerVersion(identities);
    await Bun.write(
      join(stage, "static-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await mkdir(join(output, "generations"), { recursive: true });
    const directory = join(output, "generations", id);
    await rename(stage, directory);
    const pointer = join(output, `.current-${id}`);
    try {
      await Bun.write(
        pointer,
        JSON.stringify({
          version: 1,
          directory: `generations/${id}`,
          contentVersion: version,
        }),
      );
      await rename(pointer, join(output, "current.json"));
    } catch (error) {
      await rm(pointer, { force: true });
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return { directory, manifest, version };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  } finally {
    await app.dispose();
  }
}
