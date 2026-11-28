import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createServerAssetPlugin } from "../../src/build/server-assets.ts";

test("D03: server asset URLs correspond to browser file-loader artifacts", async () => {
  await mkdir(join(process.cwd(), ".velveteen/build"), { recursive: true });
  const root = await mkdtemp(
    join(process.cwd(), ".velveteen/build/server-assets-"),
  );
  const source = join(root, "src");
  const browserDirectory = join(root, "browser");
  const serverDirectory = join(root, "server");
  await mkdir(source, { recursive: true });
  try {
    const identical =
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>\n';
    await Bun.write(join(source, "first.svg"), identical);
    await Bun.write(join(source, "second.svg"), identical);
    await Bun.write(
      join(source, "third.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>\n',
    );
    await Bun.write(join(source, "css-only.svg"), identical);
    await Bun.write(
      join(source, "document.pdf"),
      "file-loader arbitrary content",
    );
    await Bun.write(
      join(source, "styles.css"),
      '.probe { background: url("./css-only.svg"); }',
    );
    await Bun.write(
      join(source, "browser.ts"),
      'import "./styles.css"; import first from "./first.svg" with {type:"file"}; import second from "./second.svg" with {type:"file"}; import third from "./third.svg" with {type:"file"}; import document from "./document.pdf" with {type:"file"}; import generated from "virtual:generated.bin"; export {first, second, third, document, generated};',
    );
    await Bun.write(
      join(source, "server.ts"),
      'import first from "./first.svg"; import second from "./second.svg"; import third from "./third.svg"; import document from "./document.pdf" with {type:"file"}; export {first, second, third, document};',
    );
    const browserBuild = await Bun.build({
      entrypoints: [join(source, "browser.ts")],
      outdir: browserDirectory,
      target: "browser",
      publicPath: "/app/_assets/",
      naming: { entry: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
      loader: { ".svg": "file" },
      metafile: true,
      plugins: [
        {
          name: "browser-only generated file",
          setup(build) {
            build.onResolve({ filter: /^virtual:/u }, () => ({
              path: "generated.bin",
              namespace: "fixture-asset",
            }));
            build.onLoad({ filter: /./u, namespace: "fixture-asset" }, () => ({
              contents: "browser-only asset",
              loader: "file",
            }));
          },
        },
      ],
    });
    expect(browserBuild.success).toBe(true);
    if (!browserBuild.success) throw new Error("browser asset build failed");
    const plugin = await createServerAssetPlugin({
      browserBuild,
      inputRoot: process.cwd(),
      basePath: "/app",
      browserDirectory,
    });
    const serverBuild = await Bun.build({
      entrypoints: [join(source, "server.ts")],
      outdir: serverDirectory,
      target: "bun",
      allowUnresolved: [""],
      plugins: [plugin],
    });
    expect(serverBuild.success).toBe(true);
    if (!serverBuild.success) throw new Error("server asset build failed");
    const browserOutput =
      browserBuild.outputs.find((output) =>
        output.path.endsWith("browser.js"),
      ) ?? browserBuild.outputs.find((output) => output.path.endsWith(".js"));
    const serverOutput =
      serverBuild.outputs.find((output) => output.path.endsWith("server.js")) ??
      serverBuild.outputs.find((output) => output.path.endsWith(".js"));
    expect(browserOutput).toBeDefined();
    expect(serverOutput).toBeDefined();
    const browserValues = await import(browserOutput!.path);
    const serverValues = await import(serverOutput!.path);
    expect(browserValues.generated).toMatch(/^\/app\/_assets\/generated-/);
    expect(serverValues.first).toBe(browserValues.first);
    expect(serverValues.second).toBe(browserValues.second);
    expect(serverValues.third).toBe(browserValues.third);
    expect(serverValues.document).toBe(browserValues.document);
    expect(serverValues.first).not.toBe(serverValues.second);
    expect(String(serverValues.first)).toMatch(/^\/app\/_assets\/first-/);
    expect(String(serverValues.second)).toMatch(/^\/app\/_assets\/second-/);
    expect(String(serverValues.third)).toMatch(/^\/app\/_assets\/third-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
