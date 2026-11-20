import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { publicAssetUrl } from "./paths.ts";

type AssetOptions = {
  browserBuild: Bun.BuildOutput;
  inputRoot: string;
  basePath: string;
  browserDirectory: string;
};

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export async function createServerAssetPlugin(
  options: AssetOptions,
): Promise<Bun.BunPlugin> {
  if (!options.browserBuild.success || !options.browserBuild.metafile)
    throw new Error("Browser build must succeed and include a metafile");
  const browserAssets = await Promise.all(
    options.browserBuild.outputs
      .filter((output) => output.loader === "file")
      .map(async (output) => ({
        path: output.path,
        bytes: Buffer.from(await output.arrayBuffer()),
      })),
  );
  const expectedSources = new Set(
    Object.entries(options.browserBuild.metafile.outputs)
      .filter(([path]) => path.endsWith(".js"))
      .flatMap(([, output]) =>
        Object.entries(output.inputs)
          .filter(([, input]) => input.bytesInOutput > 0)
          .map(([path]) => path),
      )
      .filter(
        (path) =>
          options.browserBuild.metafile!.inputs[path]?.format === undefined,
      ),
  );
  const inputRoot = await realpath(options.inputRoot);
  const sources = [...expectedSources];
  const mapping = new Map<string, string>();
  const canonicalSource = async (source: string) => {
    const path = await realpath(resolve(inputRoot, source)).catch(
      () => undefined,
    );
    if (!path) throw new Error(`Missing browser asset input ${source}`);
    return path;
  };
  for (const source of sources) {
    const sourcePath = await canonicalSource(source);
    const bytes = await Bun.file(sourcePath)
      .arrayBuffer()
      .then((value) => Buffer.from(value));
    const sourceDigest = digest(bytes);
    const candidates = browserAssets.filter(
      (asset) => digest(asset.bytes) === sourceDigest,
    );
    const named = candidates.filter((asset) =>
      basename(asset.path).startsWith(`${basename(source, extname(source))}-`),
    );
    const matches = named.length ? named : candidates;
    if (matches.length !== 1)
      throw new Error(
        `${matches.length ? "Ambiguous" : "Missing"} browser asset correspondence for ${source}`,
      );
    const output = matches[0].path;
    const outputRelative = relative(
      resolve(options.browserDirectory),
      resolve(output),
    );
    if (
      !outputRelative ||
      isAbsolute(outputRelative) ||
      outputRelative === ".." ||
      outputRelative.startsWith(`..${sep}`)
    )
      throw new Error(
        `Browser asset output is outside browser directory: ${output}`,
      );
    mapping.set(
      sourcePath,
      publicAssetUrl(
        options.basePath,
        `_assets/${outputRelative.split(sep).join("/")}`,
      ),
    );
  }
  return {
    name: "velveteen-server-assets",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        const path = await realpath(resolve(args.resolveDir, args.path)).catch(
          () => resolve(args.resolveDir, args.path),
        );
        if (mapping.has(path))
          return { path, namespace: "velveteen-server-asset" };
        const source = relative(inputRoot, path).split(sep).join("/");
        if (expectedSources.has(source))
          throw new Error(
            `Missing server asset URL correspondence for ${path}`,
          );
        return undefined;
      });
      build.onLoad(
        { filter: /.*/, namespace: "velveteen-server-asset" },
        (args) => {
          const url = mapping.get(args.path);
          if (!url)
            throw new Error(`Missing server asset URL for ${args.path}`);
          return {
            contents: `export default ${JSON.stringify(url)};`,
            loader: "js",
          };
        },
      );
    },
  };
}
