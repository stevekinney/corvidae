import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

type Observation = {
  request: {
    method: string;
    range?: string;
    ifNoneMatch?: string;
    acceptEncoding?: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    bodyBase64: string;
    bodyText: string;
  };
};

const evidencePath = ".velveteen/evidence/d01-native-serving.json";
const bytes = new TextEncoder().encode("velveteen-native-serving\n");

const readObservation = async (
  url: string,
  request: Observation["request"],
): Promise<Observation> => {
  const headers = new Headers();
  if (request.range) headers.set("range", request.range);
  if (request.ifNoneMatch) headers.set("if-none-match", request.ifNoneMatch);
  if (request.acceptEncoding)
    headers.set("accept-encoding", request.acceptEncoding);
  const response = await fetch(url, { method: request.method, headers });
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    request,
    response: {
      status: response.status,
      headers: Object.fromEntries([...response.headers].sort()),
      bodyBase64: Buffer.from(body).toString("base64"),
      bodyText: new TextDecoder().decode(body),
    },
  };
};

test("D01: native static file responses expose their serving limits", async () => {
  await mkdir(join(process.cwd(), ".velveteen/build"), { recursive: true });
  const buildDirectory = await mkdtemp(
    join(process.cwd(), ".velveteen/build/native-serving-"),
  );
  const filePath = join(buildDirectory, "asset.txt");
  await mkdir(join(process.cwd(), ".velveteen/evidence"), { recursive: true });
  await Bun.write(filePath, bytes);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/file") return new Response(Bun.file(filePath));
      if (pathname === "/bytes")
        return new Response(new Uint8Array(bytes.buffer.slice(0)));
      return new Response("not found", { status: 404 });
    },
  });

  const requests: Observation["request"][] = [
    { method: "GET" },
    { method: "HEAD" },
    { method: "GET", range: "bytes=0-7" },
    { method: "GET", range: "bytes=999-1000" },
    { method: "GET", ifNoneMatch: '"native-probe"' },
    { method: "GET", acceptEncoding: "gzip" },
    { method: "GET", acceptEncoding: "br" },
    { method: "POST" },
  ];
  const observations: Record<string, Observation[]> = { file: [], bytes: [] };

  try {
    for (const [kind, path] of Object.entries({
      file: "/file",
      bytes: "/bytes",
    })) {
      for (const request of requests) {
        observations[kind].push(
          await readObservation(new URL(path, server.url).href, request),
        );
      }
    }

    const fileGet = observations.file[0].response;
    const bytesGet = observations.bytes[0].response;
    expect(fileGet.status).toBe(200);
    expect(bytesGet.status).toBe(200);
    expect(fileGet.bodyBase64).toBe(Buffer.from(bytes).toString("base64"));
    expect(bytesGet.bodyBase64).toBe(fileGet.bodyBase64);
    expect(fileGet.headers["content-length"]).toBe(String(bytes.byteLength));
    expect(bytesGet.headers["content-length"]).toBe(String(bytes.byteLength));
    expect(fileGet.headers["content-type"]).toBe("text/plain;charset=utf-8");
    expect(bytesGet.headers["content-type"]).toBe("application/octet-stream");

    for (const kind of ["file", "bytes"] as const) {
      const entries = observations[kind];
      expect(entries[1].response.status).toBe(200);
      expect(entries[1].response.bodyBase64).toBe("");
      expect(entries[2].response.status).toBe(kind === "file" ? 206 : 200);
      expect(entries[2].response.bodyText).toBe(
        kind === "file" ? "velvetee" : "velveteen-native-serving\n",
      );
      expect(entries[3].response.status).toBe(kind === "file" ? 416 : 200);
      expect(entries[3].response.bodyBase64).toBe(
        kind === "file" ? "" : entries[0].response.bodyBase64,
      );
      expect(entries[4].response.status).toBe(200);
      expect(entries[4].response.bodyBase64).toBe(
        entries[0].response.bodyBase64,
      );
      expect(entries[5].response.status).toBe(200);
      expect(entries[5].response.bodyBase64).toBe(
        entries[0].response.bodyBase64,
      );
      expect(entries[6].response.status).toBe(200);
      expect(entries[6].response.bodyBase64).toBe(
        entries[0].response.bodyBase64,
      );
      expect(entries[7].response.status).toBe(200);
      expect(entries[7].response.bodyBase64).toBe(
        entries[0].response.bodyBase64,
      );
      expect(entries[4].response.headers.etag).toBeUndefined();
      expect(entries[4].response.headers["cache-control"]).toBeUndefined();
      for (const index of [5, 6]) {
        expect(
          entries[index].response.headers["content-encoding"],
        ).toBeUndefined();
        expect(entries[index].response.headers.vary).toBeUndefined();
      }
      if (kind === "file") {
        expect(entries[2].response.headers["accept-ranges"]).toBe("bytes");
        expect(entries[2].response.headers["content-range"]).toBe(
          "bytes 0-7/25",
        );
        expect(entries[3].response.headers["accept-ranges"]).toBe("bytes");
        expect(entries[3].response.headers["content-range"]).toBe("bytes */25");
      }
    }

    const evidence = {
      schemaVersion: 1,
      bun: Bun.version,
      bytes: {
        length: bytes.byteLength,
        base64: Buffer.from(bytes).toString("base64"),
      },
      observations,
      policy: {
        native: [
          "Response(Bun.file(path)) supplies file content type and content length.",
          "Response(Uint8Array) supplies content length with application/octet-stream rather than a path-derived type.",
          "The listener suppresses the response body for HEAD, while the handler still returns status 200.",
          "Response(Bun.file(path)) applies byte ranges and returns 416 for an unsatisfiable range; Response(Uint8Array) ignores Range.",
          "Neither response form applies If-None-Match, cache, or Accept-Encoding policy.",
          "Neither response form restricts methods; POST receives the same 200 representation.",
        ],
        glueRequired: [
          "Manifest lookup and path/base-path policy.",
          "GET/HEAD method gating and 404/redirect behavior.",
          "Content-hash ETag and conditional requests.",
          "Range policy for byte-buffer/precompressed representations and If-Range handling; Bun.file covers basic ranges and 416 itself.",
          "Cache-Control and immutable asset policy.",
          "Precompressed asset negotiation and Vary handling.",
          "Explicit content types when serving byte buffers.",
        ],
        reference: [
          "tests/reference/upstream/packages/adapter-node/src/static.js",
          "tests/reference/upstream/packages/adapter-node/src/static.spec.ts",
        ],
      },
    };
    await Bun.write(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  } finally {
    await server.stop(true);
    await rm(buildDirectory, { recursive: true, force: true });
  }
});
