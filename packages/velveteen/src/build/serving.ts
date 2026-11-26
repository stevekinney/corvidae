import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, relative } from "node:path";
import { Duplex, Readable } from "node:stream";
import { createBrotliCompress, createGzip } from "node:zlib";
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

type AssetRoute = (request: Request) => Response | Promise<Response>;

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

const compressionFormat = (encoding: CompressionEncoding) =>
  encoding === "br" ? "brotli" : "gzip";

const compressionFallback = (encoding: CompressionEncoding) =>
  Duplex.toWeb(
    encoding === "br" ? createBrotliCompress() : createGzip(),
  ) as unknown as TransformStream;

const compress = (
  stream: ReadableStream,
  encoding: CompressionEncoding,
): ReadableStream => {
  try {
    // The DOM declaration intentionally excludes Bun's brotli format.
    return stream.pipeThrough(
      new CompressionStream(compressionFormat(encoding) as CompressionFormat),
    );
  } catch {
    return stream.pipeThrough(compressionFallback(encoding));
  }
};

type ByteRange = { end: number; start: number };

const parseRange = (value: string | null, bytes: number): ByteRange | null | undefined => {
  if (value === null) return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/iu.exec(value);
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return undefined;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix)) return null;
    return suffix === 0
      ? undefined
      : { start: Math.max(bytes - suffix, 0), end: bytes - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? bytes - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start >= bytes) return undefined;
  if (start > end) return null;
  return { start, end: Math.min(end, bytes - 1) };
};

const streamFile = async (
  file: string,
  range?: ByteRange,
): Promise<ReadableStream> => {
  const handle = await open(file);
  return Readable.toWeb(
    handle.createReadStream(range && { start: range.start, end: range.end }),
  ) as unknown as ReadableStream;
};

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
    const serve = async (request: Request): Promise<Response> => {
      if (request.method !== "GET" && request.method !== "HEAD")
        return notAllowed();
      const encoding = canCompress
        ? negotiateEncoding(
            request.headers.get("accept-encoding"),
            request.method === "GET" && request.headers.has("range"),
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
      } else {
        responseHeaders["content-length"] = String(asset.bytes);
      }
      if (
        matchesIfNoneMatch(
          request.headers.get("if-none-match"),
          responseHeaders.etag,
        )
      ) {
        return new Response(null, { status: 304, headers: responseHeaders });
      }
      const range = parseRange(
        request.method === "GET" ? request.headers.get("range") : null,
        asset.bytes,
      );
      if (range === undefined)
        return new Response(null, {
          status: 416,
          headers: {
            "accept-ranges": "bytes",
            "content-range": `bytes */${asset.bytes}`,
          },
        });
      if (range !== null) {
        responseHeaders["accept-ranges"] = "bytes";
        responseHeaders["content-length"] = String(range.end - range.start + 1);
        responseHeaders["content-range"] = `bytes ${range.start}-${range.end}/${asset.bytes}`;
      }
      if (request.method === "HEAD") {
        return new Response(null, { status: range ? 206 : 200, headers: responseHeaders });
      }
      if (encoding === "identity") {
        return new Response(await streamFile(file, range ?? undefined), {
          status: range ? 206 : 200,
          headers: responseHeaders,
        });
      }
      return new Response(compress(await streamFile(file), encoding), {
        headers: responseHeaders,
      });
    };
    routes[asset.url] = serve;
  }
  return routes;
};
