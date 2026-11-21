import { realpath } from "node:fs/promises";
import { relative, isAbsolute, sep } from "node:path";
import { productionFilePath } from "../build/paths.ts";
import { dataMediaType } from "../data/contract.ts";
import type { StaticManifest } from "./index.ts";
/** Exact native file responses from a copied artifact; no source tree or application server is required. */
export function createStaticHandler(
  directory: string,
  manifest: StaticManifest,
) {
  const responses = new Map<string, StaticManifest["responses"][number]>();
  if (manifest.version !== 1)
    throw new TypeError("Invalid static manifest version");
  for (const record of manifest.responses) {
    const url = new URL(record.url);
    if (
      url.pathname !== manifest.basePath &&
      !url.pathname.startsWith(`${manifest.basePath}/`)
    )
      throw new TypeError("Static URL outside base");
    if (responses.has(url.pathname))
      throw new TypeError("Duplicate static URL");
    productionFilePath(directory, record.file);
    if (record.dataFile) productionFilePath(directory, record.dataFile);
    responses.set(url.pathname, record);
  }
  return async (request: Request): Promise<Response> => {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    const record = responses.get(new URL(request.url).pathname);
    if (!record) return new Response("Not Found", { status: 404 });
    const data = request.headers
      .get("accept")
      ?.split(",")
      .some((type) => type.trim().split(";")[0] === dataMediaType);
    if (data && !record.dataFile)
      return new Response("Not Found", { status: 404 });
    const file = productionFilePath(
      directory,
      data ? record.dataFile! : record.file,
    );
    const root = await realpath(directory),
      actual = await realpath(file);
    const path = relative(root, actual);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
      throw new Error("Static file escapes artifact");
    const headers = new Headers(
      data
        ? {
            "content-type": `${dataMediaType}; charset=utf-8`,
            "cache-control": "no-cache",
          }
        : record.headers,
    );
    if (record.dataFile) headers.set("vary", "Accept");
    headers.set("etag", `"${data ? record.dataSha256 : record.sha256}"`);
    if (
      record.status === 200 &&
      request.headers.get("if-none-match") === headers.get("etag")
    )
      return new Response(null, { status: 304, headers });
    return new Response(
      request.method === "HEAD" || [204, 205, 304].includes(record.status)
        ? null
        : Bun.file(file),
      { status: data ? 200 : record.status, headers },
    );
  };
}
