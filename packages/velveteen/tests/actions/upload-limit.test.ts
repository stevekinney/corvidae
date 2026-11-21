import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildProduction } from "../../src/build/index.ts";
import { createApplication } from "../../src/server/index.ts";
import { dataMediaType } from "../../src/data/contract.ts";

const witness = "__velveteen_upload_limit_witness__";
const actionCount = "__velveteen_upload_limit_action_count__";
type UploadBytes = Uint8Array<ArrayBuffer>;
type UploadBody = UploadBytes | ReadableStream<UploadBytes>;

function multipartBody(fileContents: Uint8Array) {
  const boundary = "velveteen-upload-limit";
  const preamble = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const ending = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(
    preamble.byteLength + fileContents.byteLength + ending.byteLength,
  );
  body.set(preamble);
  body.set(fileContents, preamble.byteLength);
  body.set(ending, preamble.byteLength + fileContents.byteLength);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function requestFor(url: string, body: UploadBody, contentType: string) {
  return new Request(url, {
    method: "POST",
    body,
    headers: {
      accept: dataMediaType,
      origin: new URL(url).origin,
      "content-type": contentType,
      "x-velveteen-action": "true",
    },
  });
}

function chunked(body: UploadBytes) {
  return new ReadableStream<UploadBytes>({
    start(controller) {
      const split = Math.max(1, Math.floor(body.byteLength / 2));
      controller.enqueue(body.slice(0, split));
      controller.enqueue(body.slice(split));
      controller.close();
    },
  });
}

test("U: native multipart upload limit includes serialization overhead", async () => {
  const parent = resolve(".velveteen/actions");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "upload-limit-"));
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const routes = join(root, "routes");
    await mkdir(routes);
    const actionModule = join(routes, "+page.server.ts");
    await Bun.write(
      join(routes, "+page.svelte"),
      "<h1>upload limit fixture</h1>",
    );
    await Bun.write(
      actionModule,
      `export const actions={default:async({request})=>{globalThis[${JSON.stringify(actionCount)}]=(globalThis[${JSON.stringify(actionCount)}]??0)+1;const file=await request.formData().then((form)=>form.get("file"));if(!(file instanceof File))throw new Error("missing file");const text=await file.text();globalThis[${JSON.stringify(witness)}]={name:file.name,size:file.size,text};return {name:file.name,size:file.size,text};}};`,
    );
    const valid = multipartBody(new TextEncoder().encode("boundary-proof"));
    const below = multipartBody(new TextEncoder().encode("boundary-proo"));
    const oversized = multipartBody(
      new TextEncoder().encode("boundary-proof!"),
    );
    const generation = await buildProduction({
      projectDirectory: root,
      routesDirectory: routes,
      outputDirectory: join(root, "output"),
      basePath: "/app",
    });
    const admitted: {
      contentLength: string | null;
      transferEncoding: string | null;
    }[] = [];
    app = await createApplication({
      generation,
      hooks: {
        handle: ({ event, resolve }) => {
          admitted.push({
            contentLength: event.request.headers.get("content-length"),
            transferEncoding: event.request.headers.get("transfer-encoding"),
          });
          return resolve();
        },
      },
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: valid.body.byteLength,
      fetch: app.fetch,
    });
    const url = new URL("/app/", server.url);
    const actionCountValue = () => Reflect.get(globalThis, actionCount) ?? 0;
    const witnessValue = () =>
      Reflect.get(globalThis, witness) as
        { name: string; size: number; text: string } | undefined;
    const send = (body: UploadBody, type: string) =>
      fetch(requestFor(url.href, body, type));
    expect(below.body.byteLength).toBeLessThan(valid.body.byteLength);
    expect((await send(below.body, below.contentType)).status).toBe(200);
    expect(witnessValue()).toEqual({
      name: "fixture.bin",
      size: 13,
      text: "boundary-proo",
    });
    expect(actionCountValue()).toBe(1);
    expect(admitted.at(-1)).toEqual({
      contentLength: String(below.body.byteLength),
      transferEncoding: null,
    });

    expect((await send(valid.body, valid.contentType)).status).toBe(200);
    expect(witnessValue()).toEqual({
      name: "fixture.bin",
      size: 14,
      text: "boundary-proof",
    });
    expect(actionCountValue()).toBe(2);
    expect(admitted.at(-1)).toEqual({
      contentLength: String(valid.body.byteLength),
      transferEncoding: null,
    });

    expect((await send(oversized.body, oversized.contentType)).status).toBe(
      413,
    );
    expect(witnessValue()).toEqual({
      name: "fixture.bin",
      size: 14,
      text: "boundary-proof",
    });
    expect(actionCountValue()).toBe(2);
    expect(admitted).toHaveLength(2);

    expect((await send(chunked(valid.body), valid.contentType)).status).toBe(
      200,
    );
    expect(witnessValue()).toEqual({
      name: "fixture.bin",
      size: 14,
      text: "boundary-proof",
    });
    expect(actionCountValue()).toBe(3);
    expect(admitted.at(-1)?.contentLength).toBeNull();
    expect(admitted.at(-1)?.transferEncoding).toBe("chunked");

    expect(
      (await send(chunked(oversized.body), oversized.contentType)).status,
    ).toBe(413);
    expect(witnessValue()).toEqual({
      name: "fixture.bin",
      size: 14,
      text: "boundary-proof",
    });
    expect(actionCountValue()).toBe(3);
    expect(admitted).toHaveLength(4);
    expect(admitted.at(-1)?.contentLength).toBeNull();
    expect(admitted.at(-1)?.transferEncoding).toBe("chunked");
  } finally {
    Reflect.deleteProperty(globalThis, witness);
    Reflect.deleteProperty(globalThis, actionCount);
    try {
      await server?.stop(true);
      await app?.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
