import type * as compiler from "../../src/compiler/index.ts";

const compilerSpecifier = process.argv[2];
if (!compilerSpecifier) throw new Error("Missing installed compiler specifier");
const { createSveltePlugin }: typeof compiler = await import(compilerSpecifier);
import { join, basename, relative } from "node:path";
const root = import.meta.dir;
const source = join(root, "src");
const clientDirectory = join(root, "client");
const serverDirectory = join(root, "server");
const client = await Bun.build({
  entrypoints: [join(source, "client.ts")],
  outdir: clientDirectory,
  target: "browser",
  plugins: [createSveltePlugin({ css: "external", hmr: false })],
});
if (!client.success) throw new Error(JSON.stringify(client.logs));
const server = await Bun.build({
  entrypoints: [join(source, "server.ts")],
  outdir: serverDirectory,
  target: "bun",
  plugins: [
    createSveltePlugin({ target: "server", css: "external", hmr: false }),
  ],
});
if (!server.success) throw new Error(JSON.stringify(server.logs));
const serverEntry = server.outputs.find(
  (output) => output.kind === "entry-point",
);
if (!serverEntry) throw new Error("server entry was not emitted");
const rendered = (await import(serverEntry.path + "?render=" + Date.now()))
  .rendered;
if (!rendered.body.includes("Count: 3"))
  throw new Error("SSR literal was not rendered");
Bun.plugin(createSveltePlugin({ css: "injected", hmr: false }));
const runtime = await import(
  join(source, "runtime.ts") + "?runtime=" + Date.now()
);
if (typeof runtime.probe.App !== "function" || runtime.probe.value !== 3)
  throw new Error("runtime plugin import failed");
const compilerModule = import.meta.resolve(compilerSpecifier);
const compilerSvelte = Bun.resolveSync("svelte", compilerModule);
const consumerSvelte = Bun.resolveSync("svelte", join(root, "probe.ts"));
const htmlEntry = client.outputs.find(
  (output) => output.kind === "entry-point",
);
if (!htmlEntry) throw new Error("client entry was not emitted");
const cssOutput = client.outputs.find((output) => output.path.endsWith(".css"));
await Bun.write(
  join(clientDirectory, "index.html"),
  "<!doctype html><html><head>" +
    (cssOutput
      ? '<link rel="stylesheet" href="./' + basename(cssOutput.path) + '">'
      : "") +
    '</head><body><div id="app"></div><script type="module" src="./' +
    basename(htmlEntry.path) +
    '"></script></body></html>',
);
const application = join(root, "application");
await Bun.write(
  join(application, "index.html"),
  '<!doctype html><html><head><title>Fixture</title></head><body><nav><a href="#demo">Demo</a></nav><main id="app"></main><script type="module" src="./main.ts"></script></body></html>',
);
await Bun.write(
  join(application, "App.svelte"),
  '<script lang="ts">import { counter } from "./counter.svelte.ts"; import { fixtureValue } from "fixture-resolver"; import { buildMode } from "./env.ts"; let { wasmValue }: { wasmValue: number } = $props(); const counterState = counter(); let doubled = $derived(counterState.value * 2); let lazyValue = $state("not loaded"); async function loadLazy() { const module = await import("./lazy.ts"); lazyValue = module.value; }</script><section class="card"><p id="counter">Count: {counterState.value}</p><p id="derived">Double: {doubled}</p><p id="resolver">Resolver: {fixtureValue}</p><p id="wasm">WASM: {wasmValue}</p><p id="mode">Mode: {buildMode}</p><button id="increment" onclick={() => counterState.increment()}>Increment</button><button id="lazy" onclick={loadLazy}>Load lazy</button><p id="lazy-result">Lazy: {lazyValue}</p></section><style>.card { color: rgb(9, 8, 7); }</style>',
);
await Bun.write(
  join(application, "counter.svelte.ts"),
  "export function counter() { let value = $state(1); return { get value() { return value; }, increment() { value += 1; } }; }",
);
await Bun.write(join(application, "lazy.ts"), 'export const value = "loaded";');
await Bun.write(
  join(application, "resolver.ts"),
  'export const fixtureValue = "fixture-resolver-value";',
);
await Bun.write(
  join(application, "env.ts"),
  "export const buildMode = process.env.NODE_ENV;",
);
await Bun.write(
  join(application, "wasm-value.ts"),
  'import instantiate from "./tiny.wasm"; const result = await instantiate({}); export const wasmValue = (result.instance.exports.add1 as (value: number) => number)(4);',
);
await Bun.write(
  join(application, "main.ts"),
  'import { mount } from "svelte"; import App from "./App.svelte"; import { wasmValue } from "./wasm-value.ts"; mount(App, { target: document.getElementById("app")!, props: { wasmValue } });',
);
await Bun.write(
  join(application, "tiny.wasm"),
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 127, 1, 127, 3, 2, 1, 0, 7, 8,
    1, 4, 97, 100, 100, 49, 0, 0, 10, 9, 1, 7, 0, 32, 0, 65, 1, 106, 11,
  ]),
);
const wasmPlugin: Bun.BunPlugin = {
  name: "fixture-wasm",
  setup(builder) {
    builder.onLoad({ filter: /\.wasm$/, namespace: "file" }, ({ path }) => ({
      loader: "js",
      contents:
        "import url from " +
        JSON.stringify("wasm-asset:" + path) +
        "; export default (imports) => WebAssembly.instantiateStreaming(fetch(url), imports);",
    }));
    builder.onResolve({ filter: /^wasm-asset:/ }, ({ path }) => ({
      path: path.slice("wasm-asset:".length) + ".binary.wasm",
      namespace: "wasm-asset",
    }));
    builder.onLoad(
      { filter: /.*/, namespace: "wasm-asset" },
      async ({ path }) => ({
        contents: await Bun.file(path.slice(0, -".binary.wasm".length)).bytes(),
        loader: "file",
      }),
    );
  },
};
const resolverPlugin: Bun.BunPlugin = {
  name: "fixture-resolver",
  setup(builder) {
    builder.onResolve({ filter: /^fixture-resolver$/ }, () => ({
      path: join(application, "resolver.ts"),
    }));
  },
};
const buildApplication = async (development: boolean) => {
  const outdir = join(
    root,
    development ? "application-development" : "application-production",
  );
  const result = await Bun.build({
    entrypoints: [join(application, "index.html")],
    outdir,
    conditions: ["browser", "svelte", "unwasm"],
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        development ? "development" : "production",
      ),
    },
    format: "esm",
    publicPath: "/",
    target: "browser",
    plugins: [
      wasmPlugin,
      resolverPlugin,
      createSveltePlugin({
        target: "client",
        css: "injected",
        development,
        hmr: false,
      }),
    ],
    sourcemap: development ? "linked" : "none",
    splitting: true,
    metafile: true,
    naming: {
      entry: "[name].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
  });
  if (!result.success || !result.metafile)
    throw new Error("application build failed: " + JSON.stringify(result.logs));
  if (result.logs.some((log) => log.level === "warning"))
    throw new Error(
      "application build emitted warnings: " + JSON.stringify(result.logs),
    );
  const outputs = await Promise.all(
    result.outputs.map(async (output) => ({
      path: output.path,
      bytes: (await Bun.file(output.path).bytes()).length,
      sha256: new Bun.CryptoHasher("sha256")
        .update(await Bun.file(output.path).arrayBuffer())
        .digest("hex"),
    })),
  );
  const maps = outputs
    .filter((output) => output.path.endsWith(".map"))
    .map((output) => output.path);
  const html = await Bun.file(join(outdir, "index.html")).text();
  if (!html.includes("/assets/"))
    throw new Error("application HTML has no public hashed asset URL");
  for (const output of outputs.filter((output) =>
    output.path.endsWith(".js"),
  )) {
    const javascript = await Bun.file(output.path).text();
    // Injected development CSS contains its own inline map inside a string.
    // Only a JavaScript directive on its own line describes this bundle.
    const sourceMapLink = javascript.match(
      /^\/\/# sourceMappingURL=(\S+)$/m,
    )?.[1];
    const javascriptUrl = new URL(
      relative(outdir, output.path),
      "https://fixture.invalid/",
    );
    const sourceMapUrl = sourceMapLink
      ? new URL(sourceMapLink, javascriptUrl)
      : undefined;
    const sourceMapFile = sourceMapUrl
      ? Bun.file(join(outdir, sourceMapUrl.pathname.slice(1)))
      : undefined;
    if (
      development &&
      (!sourceMapFile ||
        sourceMapUrl?.origin !== javascriptUrl.origin ||
        !(await sourceMapFile.exists()))
    )
      throw new Error(
        `development JavaScript map link is missing: ${output.path} -> ${sourceMapLink}`,
      );
    if (development && sourceMapFile) {
      const map = await sourceMapFile.json();
      if (
        map.version !== 3 ||
        !Array.isArray(map.sources) ||
        map.sources.length === 0
      )
        throw new Error("Development source map has no source provenance");
    }
    if (!development && sourceMapLink)
      throw new Error("production JavaScript unexpectedly links a source map");
  }
  const wasmAsset = outputs.find((output) => output.path.endsWith(".wasm"));
  if (!wasmAsset) throw new Error("application WASM asset was not emitted");
  if (development !== maps.length > 0)
    throw new Error("application source-map mode mismatch");
  if (!outputs.some((output) => output.path.endsWith("index.html")))
    throw new Error("application HTML was not emitted");
  return {
    development,
    outdir,
    metafile: result.metafile,
    outputs,
    maps,
    wasmAsset: wasmAsset.path,
    html,
    buildLogs: result.logs.map(String),
  };
};
const applications = [
  await buildApplication(true),
  await buildApplication(false),
];
console.log(
  JSON.stringify({
    clientOutputs: client.outputs.length,
    serverOutputs: server.outputs.length,
    rendered: rendered.body,
    runtime: runtime.probe.value,
    compilerSvelte,
    consumerSvelte,
    clientEntry: basename(htmlEntry.path),
    applications,
  }),
);
