import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createSveltePlugin } from "../../src/compiler/index";

type NativeProbe = {
  outputPaths: string[];
  metafileAssetOutputs: string[];
  buildOutputAssets: string[];
  entryOutputs: Record<
    string,
    { path: string; cssBundle?: string; imports: string[] }
  >;
  metafile: Bun.BuildMetafile;
  css: string;
  cssAsset: string;
};

const projectRoot = resolve(import.meta.dir, "../..");
const evidencePath = join(projectRoot, ".velveteen/evidence/d01-bundler.json");
const sharedBuildRoot = join(projectRoot, ".velveteen/build");

const outputName = (root: string, path: string) => relative(root, path);

test("D01: Bun.build exposes the production graph and Svelte plugin boundaries", async () => {
  await mkdir(sharedBuildRoot, { recursive: true });
  const buildRoot = await mkdtemp(join(sharedBuildRoot, "bundler-"));
  const nativeSource = join(buildRoot, "native-source");
  const nativeOutput = join(buildRoot, "native-output");
  const svelteSource = join(buildRoot, "svelte-source");
  const svelteOutput = join(buildRoot, "svelte-output");
  let nativeProbe: NativeProbe | undefined;
  let svelteProbe: Record<string, unknown> | undefined;

  try {
    await mkdir(nativeSource, { recursive: true });
    await mkdir(svelteSource, { recursive: true });
    await Bun.write(
      join(nativeSource, "shared.ts"),
      'export const shared = "shared-value";\n',
    );
    await Bun.write(
      join(nativeSource, "lazy.ts"),
      'import { shared } from "./shared"; export const lazy = `${shared}-lazy`;\n',
    );
    await Bun.write(
      join(nativeSource, "alpha.ts"),
      'import { shared } from "./shared"; export const alpha = shared; export const load = () => import("./lazy");\n',
    );
    await Bun.write(
      join(nativeSource, "beta.ts"),
      'import { shared } from "./shared"; import background from "./background.svg" with { type: "file" }; export const beta = `${shared}-beta`; export const backgroundPath = background;\n',
    );
    await Bun.write(
      join(nativeSource, "background.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0h1v1H0z"/><metadata>${"native-asset-".repeat(900)}</metadata></svg>\n`,
    );
    await Bun.write(
      join(nativeSource, "styles.css"),
      '.native { background-image: url("./background.svg"); }\n',
    );
    await Bun.write(
      join(nativeSource, "alpha.ts"),
      'import "./styles.css"; import { shared } from "./shared"; export const alpha = shared; export const load = () => import("./lazy");\n',
    );

    const nativeBuild = await Bun.build({
      entrypoints: [
        join(nativeSource, "alpha.ts"),
        join(nativeSource, "beta.ts"),
      ],
      outdir: nativeOutput,
      target: "browser",
      splitting: true,
      publicPath: "/app/_assets/",
      naming: {
        entry: "entries/[name]-[hash].[ext]",
        chunk: "chunks/[name]-[hash].[ext]",
        asset: "assets/[name]-[hash].[ext]",
      },
      loader: { ".svg": "file" },
      metafile: true,
    });
    expect(nativeBuild.success).toBe(true);
    if (!nativeBuild.success || !nativeBuild.metafile)
      throw new Error("Bun native production build did not produce a metafile");

    const metafile = nativeBuild.metafile;
    const outputEntries = Object.entries(metafile.outputs);
    const entryOutputs: NativeProbe["entryOutputs"] = {};
    for (const [path, output] of outputEntries) {
      if (output.entryPoint && path.endsWith(".js")) {
        entryOutputs[basename(output.entryPoint)] = {
          path,
          cssBundle: output.cssBundle,
          imports: output.imports.map((item) => item.path),
        };
      }
    }
    expect(Object.keys(entryOutputs).sort()).toEqual([
      "alpha.ts",
      "beta.ts",
      "lazy.ts",
    ]);
    expect(entryOutputs["alpha.ts"]?.cssBundle).toBeDefined();
    expect(
      entryOutputs["alpha.ts"]?.imports.some((path) => path.includes("lazy")),
    ).toBe(true);
    expect(
      Object.keys(metafile.outputs).some((path) => path.includes("chunks/")),
    ).toBe(true);
    expect(
      Object.keys(metafile.outputs).every((path) =>
        /-[a-z0-9]+\.(?:js|css|svg)$/.test(path),
      ),
    ).toBe(true);
    const betaOutput = Object.keys(metafile.outputs).find((path) =>
      path.includes("entries/beta-"),
    );
    expect(betaOutput).toBeDefined();
    expect(
      await readFile(resolve(nativeOutput, betaOutput!), "utf8"),
    ).toContain("/app/_assets/");

    const cssPath = resolve(nativeOutput, entryOutputs["alpha.ts"]!.cssBundle!);
    const css = await readFile(cssPath, "utf8");
    const cssAssetMatch = css.match(
      /url\(["']?(\/app\/_assets\/[^)'" ]+|data:image\/svg\+xml;base64,[^)'" ]+)["']?\)/,
    );
    expect(cssAssetMatch).not.toBeNull();
    const cssAsset = cssAssetMatch![1]!;
    expect(cssAsset).toMatch(/background-|data:image\/svg\+xml;base64,/);
    nativeProbe = {
      outputPaths: nativeBuild.outputs.map((output) =>
        outputName(buildRoot, output.path),
      ),
      metafileAssetOutputs: Object.keys(metafile.outputs).filter((path) =>
        path.includes("background-"),
      ),
      buildOutputAssets: nativeBuild.outputs
        .map((output) => outputName(buildRoot, output.path))
        .filter((path) => path.endsWith(".svg")),
      entryOutputs: Object.fromEntries(
        Object.entries(entryOutputs).map(([entry, output]) => [
          entry,
          {
            ...output,
            path: output.path,
            cssBundle: output.cssBundle,
          },
        ]),
      ),
      metafile,
      css,
      cssAsset,
    };

    await Bun.write(
      join(svelteSource, "icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><circle cx="1" cy="1" r="1"/></svg>\n',
    );
    await Bun.write(
      join(svelteSource, "Child.svelte"),
      '<script>import icon from "./icon.svg";</script><div class="child"><img src={icon} alt="child" /></div><style>.child { background-image: url("./icon.svg"); }</style>',
    );
    await Bun.write(
      join(svelteSource, "RouteA.svelte"),
      '<script>import Child from "./Child.svelte";</script><main><Child /></main>',
    );
    await Bun.write(
      join(svelteSource, "RouteB.svelte"),
      "<h1>Route B</h1><style>h1 { color: purple; }</style>",
    );
    await Bun.write(
      join(svelteSource, "browser.ts"),
      'import RouteA from "./RouteA.svelte"; import RouteB from "./RouteB.svelte"; export { RouteA, RouteB };',
    );
    await Bun.write(
      join(svelteSource, "server.ts"),
      'import { render } from "svelte/server"; import RouteB from "./RouteB.svelte"; export const renderRoute = () => render(RouteB).body;',
    );

    let browserBuild: Bun.BuildOutput | undefined;
    let browserError: unknown;
    try {
      browserBuild = await Bun.build({
        entrypoints: [join(svelteSource, "browser.ts")],
        outdir: svelteOutput,
        target: "browser",
        splitting: true,
        metafile: true,
        plugins: [createSveltePlugin()],
        throw: false,
      });
    } catch (error) {
      browserError = error;
    }
    const serverOutput = join(svelteOutput, "server");
    const serverBuild = await Bun.build({
      entrypoints: [join(svelteSource, "server.ts")],
      outdir: serverOutput,
      target: "bun",
      plugins: [createSveltePlugin({ target: "server" })],
    });
    expect(serverBuild.success).toBe(true);
    if (!serverBuild.success) throw new Error("SSR build failed");
    const rendered = (
      await import(join(serverOutput, "server.js"))
    ).renderRoute();
    expect(rendered).toContain("Route B");

    svelteProbe = {
      browserSuccess: browserBuild?.success ?? false,
      browserOutputs:
        browserBuild?.outputs.map((output) =>
          outputName(buildRoot, output.path),
        ) ?? [],
      browserLogs: browserBuild?.success
        ? []
        : (browserBuild?.logs.map(String) ?? [String(browserError)]),
      serverSuccess: serverBuild.success,
      ssrRendered: rendered,
      pluginGap: browserBuild?.success
        ? null
        : "RouteA -> Child.svelte CSS with relative url(./icon.svg) does not resolve through the plugin's virtual stylesheet namespace; the plugin uses process.cwd() as resolveDir.",
    };
    expect(browserBuild?.success ?? false).toBe(true);
  } finally {
    await Bun.write(
      evidencePath,
      JSON.stringify(
        {
          probe: "D01-native-bundler",
          runtime: `Bun ${Bun.version}`,
          native: nativeProbe,
          svelte: svelteProbe,
          observed: {
            native:
              "Bun emits hashed entry/chunk/asset paths in BuildOutput.outputs, reports entryPoint/cssBundle/imports in metafile outputs, prefixes imported file URLs with publicPath, and resolves a relative CSS url(asset) to a data URI. The file-loader SVG artifact is present in BuildOutput.outputs but absent from metafile.outputs, so metafile provenance alone cannot map SSR asset URLs.",
            svelte:
              "SSR target imports and renders a real compiled module; the browser graph exposes a plugin gap for relative CSS url() resolution in a child component stylesheet when the build fails.",
          },
        },
        null,
        2,
      ) + "\n",
    );
    await rm(buildRoot, { recursive: true, force: true });
  }
});
