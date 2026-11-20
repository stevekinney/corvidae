import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { prerender } from "../../src/prerender/index.ts";
import { createStaticHandler } from "../../src/prerender/serve.ts";
import { readDataResponse } from "../../src/data/transport.ts";
import { dataMediaType } from "../../src/data/contract.ts";
import { staticFixture } from "./fixture.ts";

test("R: prerendered route escapes remain separate from parameter text", async () => {
  const route = "/escapes/a[x+23]b/[id]";
  const directory = `routes${route}`;
  const fixture = await staticFixture({
    [`${directory}/+page.server.ts`]:
      "export const load = ({ params }) => ({ value: params.id });",
    [`${directory}/+page.svelte`]:
      '<script lang="ts">let { data } = $props();</script><h1>Escaped route: {data.value}</h1>',
  });
  try {
    const result = await prerender({
      generation: await fixture.build(),
      outputDirectory: fixture.outputDirectory,
      entries: [{ route, params: { id: "[x+2f]" } }],
    });
    const handle = createStaticHandler(result.directory, result.manifest);
    const url = "https://relocated.test/docs/escapes/a%23b/%5Bx%2B2f%5D";
    const html = await handle(new Request(url));
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("<h1>Escaped route: [x+2f]</h1>");
    const response = await handle(
      new Request(url, { headers: { accept: dataMediaType } }),
    );
    const { payload, done } = await readDataResponse(response);
    await done;
    expect(payload.routeId).toBe(route);
    expect(payload.params).toEqual({ id: "[x+2f]" });
    expect(
      (await handle(new Request(url.replace("%23", "%2523")))).status,
    ).toBe(404);
  } finally {
    await fixture.dispose();
  }
});

test("M: qualified prerender entries preserve capture ownership and the prior artifact", async () => {
  const directory = "routes/manual/[[section=integer]]/[...path=public-path]";
  const fixture = await staticFixture({
    "src/params.ts": `export const params = {
      integer: (value: string) => /^\\d+$/.test(value) ? Number(value) : undefined,
      "public-path": (value: string) => value === "blocked" ? undefined : value,
    };`,
    [`${directory}/+page.server.ts`]:
      "export const load = ({ params }) => ({ ...params });",
    [`${directory}/+page.svelte`]:
      '<script lang="ts">let { data } = $props();</script><h1>{data.section ?? "omitted"}:{data.path}</h1>',
    "routes/manual/index/+page.svelte": "<h1>Static precedence</h1>",
  });
  try {
    const generation = await fixture.build();
    const outputDirectory = fixture.outputDirectory;
    const options = { generation, outputDirectory };
    const route = "/manual/[[section=integer]]/[...path=public-path]";
    const result = await prerender({
      ...options,
      entries: [
        { route, params: { section: "42", path: "guide/install" } },
        { route, params: { path: "" } },
        { route, params: { path: "guide/%2F" } },
      ],
    });
    const handler = createStaticHandler(result.directory, result.manifest);
    const captured = [
      ["/docs/manual/42/guide/install", { section: 42, path: "guide/install" }],
      ["/docs/manual", { path: "" }],
      ["/docs/manual/guide/%252F", { path: "guide/%2F" }],
    ] as const;
    for (const [pathname, params] of captured) {
      const response = await handler(
        new Request(`https://relocated.test${pathname}`, {
          headers: { accept: dataMediaType },
        }),
      );
      expect(response.status).toBe(200);
      const decoded = await readDataResponse(response);
      await decoded.done;
      expect(decoded.payload.routeId).toBe(route);
      expect(decoded.payload.params).toEqual(params);
    }
    const pointer = Bun.file(join(outputDirectory, "current.json"));
    const accepted = await pointer.text();
    const invalid: Array<[Record<string, string>, string]> = [
      [{ section: "", path: "guide" }, "Entry changes route parameter section"],
      [
        { section: "guide", path: "install" },
        "Entry changes route parameter section",
      ],
      [{ path: "42/guide" }, "Entry changes route parameter section"],
      [{ path: "blocked" }, "Entry does not match route"],
      [{ path: "index" }, "Entry does not match route"],
    ];
    for (const [params, message] of invalid) {
      expect(
        await throwingRejectionOf(
          prerender({ ...options, entries: [{ route, params }] }),
        ),
      ).toThrow(message);
      expect(await pointer.text()).toBe(accepted);
    }
  } finally {
    await fixture.dispose();
  }
});

test("L: prerender entries validate URL captures and preserve typed parameters in artifacts", async () => {
  const fixture = await staticFixture({
    "src/params.ts":
      "export const params = { large: (value: string) => /^\\d+$/.test(value) ? BigInt(value) : undefined };",
    "routes/large/[id=large]/+page.server.ts":
      "export const load = ({ params }) => ({ id: params.id });",
    "routes/large/[id=large]/+page.svelte":
      '<script lang="ts">let { data } = $props();</script><h1>{typeof data.id} {String(data.id)}</h1>',
  });
  try {
    const generation = await fixture.build();
    const outputDirectory = fixture.outputDirectory;
    const route = "/large/[id=large]";
    const artifact = await prerender({
      generation,
      outputDirectory,
      entries: [{ route, params: { id: "9007199254740993" } }],
    });
    const pointer = Bun.file(join(outputDirectory, "current.json"));
    const accepted = await pointer.text();
    const handler = createStaticHandler(artifact.directory, artifact.manifest);
    const url = "https://relocated.test/docs/large/9007199254740993";
    const html = await handler(new Request(url));
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("bigint 9007199254740993");
    const response = await handler(
      new Request(url, { headers: { accept: dataMediaType } }),
    );
    const decoded = await readDataResponse(response);
    await decoded.done;
    expect(decoded.payload.params.id).toBe(9007199254740993n);
    expect(
      await throwingRejectionOf(
        prerender({
          generation,
          outputDirectory,
          entries: [{ route, params: { id: "rejected" } }],
        }),
      ),
    ).toThrow("Entry does not match route /large/[id=large]");
    expect(await pointer.text()).toBe(accepted);
  } finally {
    await fixture.dispose();
  }
});

test("H01: actual base-path artifacts include crawled dynamic pages, endpoints, redirects, options and all assets", async () => {
  const fixture = await staticFixture({
    "routes/+page.svelte": '<h1>Home</h1><a href="blog/one">One</a>',
    "routes/blog/[slug]/+page.server.ts":
      "export const load=({params})=>({slug:params.slug});",
    "routes/blog/[slug]/+page.svelte":
      "<script>let {data}=$props();</script><h1>Post {data.slug}</h1><a href='../'>Home</a>",
    "routes/always/+page.ts": "export const trailingSlash='always';",
    "routes/always/+page.svelte": "<h1>Always slash</h1>",
    "routes/runtime/+page.ts": "export const prerender=false;",
    "routes/runtime/+page.svelte": "<h1>Runtime only</h1>",
    "routes/api/+server.ts":
      "export const prerender=true;export const GET=()=>new Response('endpoint bytes',{headers:{'content-type':'text/plain','x-static':'yes'}});",
    "routes/redirect/+page.server.ts": `import {redirect} from ${JSON.stringify(resolve("src/data/errors.ts"))};export const load=()=>redirect(303,'/docs/blog/one');`,
    "routes/redirect/+page.svelte": "<h1>Unreachable</h1>",
  });
  try {
    const generation = await fixture.build();
    const output = await prerender({
      generation,
      outputDirectory: fixture.outputDirectory,
      entries: ["/docs/runtime"],
    });
    const handler = createStaticHandler(output.directory, output.manifest);
    for (const [path, text] of [
      ["/docs/", "Home"],
      ["/docs/blog/one", "Post one"],
      ["/docs/always/", "Always slash"],
      ["/docs/api", "endpoint bytes"],
      ["/docs/public.txt", "Public A"],
    ]) {
      const response = await handler(
        new Request(`https://relocated.test${path}`),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(text);
    }
    expect(
      (await handler(new Request("https://relocated.test/docs/runtime")))
        .status,
    ).toBe(404);
    expect(
      (await handler(new Request("https://relocated.test/public.txt"))).status,
    ).toBe(404);
    const canonical = await handler(
      new Request("https://relocated.test/docs/always"),
    );
    expect(canonical.status).toBe(308);
    expect(canonical.headers.get("location")).toBe("/docs/always/");
    const redirect = await handler(
      new Request("https://relocated.test/docs/redirect"),
    );
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe("/docs/blog/one");
    const data = await handler(
      new Request("https://relocated.test/docs/blog/one", {
        headers: { accept: dataMediaType },
      }),
    );
    const decoded = await readDataResponse(data);
    await decoded.done;
    expect(decoded.payload.nodes.at(-1)?.data).toEqual({ slug: "one" });
    expect(decoded.payload.prerendered).toBe(true);
    for (const asset of generation.manifest.assets) {
      const response = await handler(
        new Request(`https://relocated.test${asset.url}`),
      );
      expect(response.status).toBe(200);
      expect(
        new Bun.CryptoHasher("sha256")
          .update(await response.arrayBuffer())
          .digest("hex"),
      ).toBe(asset.sha256);
    }
    expect(
      await Bun.file(join(output.directory, "docs/blog/one.html")).exists(),
    ).toBe(true);
    expect(
      await Bun.file(join(output.directory, "docs/always/index.html")).exists(),
    ).toBe(true);
  } finally {
    await fixture.dispose();
  }
});
test("H01: explicit string and parameter entries use the canonical route grammar; content identities change with public bytes", async () => {
  const fixture = await staticFixture({
    "routes/blog/[slug]/+page.svelte": "<h1>Explicit</h1>",
    "routes/files/[...path]/+page.ts": "export const prerender='auto';",
    "routes/files/[...path]/+page.svelte": "<h1>Rest</h1>",
  });
  try {
    const generation = await fixture.build();
    const options = {
      generation,
      outputDirectory: fixture.outputDirectory,
      entries: [
        "/docs/blog/one",
        { route: "/files/[...path]", params: { path: "a/b" } },
      ],
    };
    const first = await prerender(options),
      repeat = await prerender(options);
    expect(repeat.version).toBe(first.version);
    expect(
      first.manifest.responses.some(
        (record) => new URL(record.url).pathname === "/docs/files/a/b",
      ),
    ).toBe(true);
    await fixture.write({ "static/public.txt": "Public B" });
    const next = await prerender({
      ...options,
      generation: await fixture.build(),
    });
    expect(next.version).not.toBe(first.version);
    expect(
      await Bun.file(join(first.directory, "docs/public.txt")).text(),
    ).toBe("Public A");
    expect(await Bun.file(join(next.directory, "docs/public.txt")).text()).toBe(
      "Public B",
    );
  } finally {
    await fixture.dispose();
  }
});
