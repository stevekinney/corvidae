import type { ProductionAsset } from "./manifest-types.ts";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Canonical deployment prefix; all generated URLs are absolute paths within this prefix. */
export function normalizeBasePath(input = ""): string {
  if (input === "" || input === "/") return "";
  const base = input.endsWith("/") ? input.slice(0, -1) : input;
  if (
    !base.startsWith("/") ||
    base
      .slice(1)
      .split("/")
      .some(
        (segment) =>
          !/^[A-Za-z0-9._~-]+$/.test(segment) ||
          segment === "." ||
          segment === "..",
      )
  )
    throw new Error(`Invalid production base path ${input}`);
  return base;
}

/** Accept only portable relative output paths, with no encoded or platform-dependent traversal. */
export function productionFilePath(directory: string, file: string): string {
  if (
    !file ||
    isAbsolute(file) ||
    file.includes("\\") ||
    file.split("/").some((part) => !part || part === "." || part === "..") ||
    file.includes("\0")
  )
    throw new Error(`Invalid production file path ${file}`);
  const path = resolve(directory, file);
  const location = relative(resolve(directory), path);
  if (
    isAbsolute(location) ||
    location === ".." ||
    location.startsWith(`..${sep}`)
  )
    throw new Error(`Production file escapes directory: ${file}`);
  return path;
}

export function publicAssetUrl(basePath: string, file: string): string {
  productionFilePath("/", file);
  return `${normalizeBasePath(basePath)}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

/** Map only declared browser/static output prefixes to public URLs. Server outputs are never public. */
export function canonicalAssetUrl(
  basePath: string,
  asset: ProductionAsset,
): string {
  let file: string;
  if (asset.target === "browser" && asset.file.startsWith("browser/"))
    file = "_assets/" + asset.file.slice("browser/".length);
  else if (asset.target === "static" && asset.file.startsWith("static/")) {
    file = asset.file.slice("static/".length);
    if (file === "_assets" || file.startsWith("_assets/"))
      throw new Error("Static files collide with the _assets namespace");
  } else throw new Error(`asset has no public file mapping: ${asset.file}`);
  return publicAssetUrl(normalizeBasePath(basePath), file);
}
