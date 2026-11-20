import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  ProductionGeneration,
  ProductionAsset,
} from "./manifest-types.ts";
import {
  canonicalAssetUrl,
  normalizeBasePath,
  productionFilePath,
} from "./paths.ts";

const isSafeAssetFile = (directory: string, asset: ProductionAsset): string => {
  productionFilePath(directory, asset.file);
  if (lstatSync(directory).isSymbolicLink()) {
    throw new Error("production generation directory must not be a symlink");
  }
  const root = realpathSync(directory);
  const path = realpathSync(join(root, asset.file));
  const fromRoot = relative(root, path);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith("../") ||
    fromRoot.includes("/../")
  ) {
    throw new Error(`asset path escapes generation: ${asset.file}`);
  }
  if (!statSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`asset is not a regular file: ${asset.file}`);
  }
  return path;
};

const matchesIfNoneMatch = (header: string | null, etag: string): boolean =>
  header
    ?.split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value.replace(/^W\//, "") === etag) ??
  false;

const notAllowed = () =>
  new Response("method not allowed", {
    status: 405,
    headers: { allow: "GET, HEAD" },
  });

type AssetRoute = (request: Request) => Response;

type CompressionEncoding = "br" | "gzip";

type CompressionOptions = {
  compression?: boolean;
};

const compressibleContentType = (contentType: string): boolean => {
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType.startsWith("text/")) return true;
  if (mediaType === "image/svg+xml") return true;
  return [
    "application/ecmascript",
    "application/javascript",
    "application/json",
    "application/manifest+json",
    "application/xml",
    "application/xhtml+xml",
  ].includes(mediaType);
};

const parseQuality = (value: string): number => {
  if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) return 0;
  return Number(value);
};

const negotiateEncoding = (
  header: string | null,
  identityOnly: boolean,
): CompressionEncoding | "identity" | null => {
  const preferences = new Map<string, number>();
  for (const item of (header ?? "").split(",")) {
    const [rawName, ...parameters] = item.trim().toLowerCase().split(";");
    const name = rawName.trim();
    if (!name || preferences.has(name)) continue;
    const weight = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    preferences.set(
      name,
      weight === undefined ? 1 : parseQuality(weight.slice(2)),
    );
  }

  const wildcard = preferences.get("*");
  const identity = preferences.get("identity");
  const identityAllowed = (identity ?? (wildcard === 0 ? 0 : 1)) > 0;
  if (identityOnly) return identityAllowed ? "identity" : null;

  const brotli = preferences.get("br") ?? wildcard ?? 0;
  const gzip = preferences.get("gzip") ?? wildcard ?? 0;
  const compressed = Math.max(brotli, gzip);
  if (compressed > 0 && compressed >= (identity ?? 0))
    return brotli >= gzip ? "br" : "gzip";
  return identityAllowed ? "identity" : null;
};

const compressionFormat = (
  encoding: CompressionEncoding,
): Bun.CompressionFormat => (encoding === "br" ? "brotli" : "gzip");

const BunCompressionStream = CompressionStream as new (
  format: Bun.CompressionFormat,
) => CompressionStream;

const representationTag = (etag: string, encoding: CompressionEncoding) =>
  `${etag.slice(0, -1)}-${encoding}"`;

export const createProductionAssetRoutes = (
  generation: ProductionGeneration,
  options: CompressionOptions = {},
): Record<string, AssetRoute> => {
  const routes: Record<string, AssetRoute> = {};
  const basePath = normalizeBasePath(generation.manifest.basePath);
  const urls = new Set<string>();
  for (const asset of generation.manifest.assets) {
    if (asset.url !== canonicalAssetUrl(basePath, asset))
      throw new Error(`asset URL is not canonical: ${asset.url}`);
    if (urls.has(asset.url))
      throw new Error(`duplicate asset URL: ${asset.url}`);
    urls.add(asset.url);
    const file = isSafeAssetFile(generation.directory, asset);
    const information = statSync(file);
    const digest = createHash("sha256")
      .update(readFileSync(file))
      .digest("hex");
    if (information.size !== asset.bytes || digest !== asset.sha256) {
      throw new Error(
        `asset does not match its production manifest: ${asset.url}`,
      );
    }
    const etag = `"${asset.sha256}"`;
    const headers: Record<string, string> = {
      "cache-control": asset.immutable
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "content-type": asset.contentType,
      etag,
    };
    const canCompress =
      options.compression === true &&
      compressibleContentType(asset.contentType);
    const serve = (request: Request): Response => {
      if (request.method !== "GET" && request.method !== "HEAD")
        return notAllowed();
      const encoding = canCompress
        ? negotiateEncoding(
            request.headers.get("accept-encoding"),
            request.headers.has("range"),
          )
        : "identity";
      const responseHeaders = { ...headers };
      if (canCompress) responseHeaders.vary = "Accept-Encoding";
      if (encoding === null)
        return new Response(null, {
          status: 406,
          headers: { vary: "Accept-Encoding" },
        });
      if (encoding !== "identity") {
        responseHeaders["content-encoding"] = encoding;
        responseHeaders.etag = representationTag(etag, encoding);
      }
      if (
        matchesIfNoneMatch(
          request.headers.get("if-none-match"),
          responseHeaders.etag,
        )
      ) {
        return new Response(null, { status: 304, headers: responseHeaders });
      }
      if (request.method === "HEAD" && canCompress) {
        if (encoding === "identity") {
          responseHeaders["content-length"] = String(asset.bytes);
        }
        return new Response(null, { headers: responseHeaders });
      }
      if (encoding === "identity") {
        return new Response(Bun.file(file), { headers: responseHeaders });
      }
      const stream = Bun.file(file)
        .stream()
        // Bun supports the native brotli format, while the DOM declaration
        // intentionally only lists the standard CompressionStream formats.
        .pipeThrough(new BunCompressionStream(compressionFormat(encoding)));
      return new Response(stream, { headers: responseHeaders });
    };
    routes[asset.url] = serve;
  }
  return routes;
};
