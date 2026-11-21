import {
  compile,
  compileModule,
  parse,
  type CompileOptions,
  type CompileResult,
  type ModuleCompileOptions,
} from "svelte/compiler";
import ts from "typescript";
import remapping from "@jridgewell/remapping";
import { dirname } from "node:path";

export type CompilationTarget = "client" | "server";

export type CompiledAsset = {
  code: string;
  map: string | null;
  css: { code: string; map: string | null } | null;
  warnings: readonly unknown[];
  dependencies: readonly string[];
};

const mapText = (map: unknown): string | null => {
  if (!map) return null;
  return typeof map === "string" ? map : JSON.stringify(map);
};

const resultToAsset = (result: CompileResult): CompiledAsset => ({
  code: result.js.code,
  map: mapText(result.js.map),
  css: result.css
    ? { code: result.css.code, map: mapText(result.css.map) }
    : null,
  warnings: result.warnings,
  dependencies: [],
});

/** Compile a Svelte component for either the browser or a DOM-free SSR graph. */
export function compileComponent(
  source: string,
  options: Omit<CompileOptions, "generate"> & {
    filename: string;
    target?: CompilationTarget;
  },
): CompiledAsset {
  const { target = "client", ...compilerOptions } = options;
  return resultToAsset(
    compile(source, {
      ...compilerOptions,
      filename: options.filename,
      generate: target,
      css: compilerOptions.css ?? "external",
    }),
  );
}

/**
 * Compile a `.svelte.ts`/`.svelte.js` rune module. TypeScript is erased before
 * Svelte sees the module so rune calls remain available to the rune compiler.
 */
export function compileRuneModule(
  source: string,
  options: Omit<ModuleCompileOptions, "generate"> & {
    filename: string;
    target?: CompilationTarget;
  },
): CompiledAsset {
  const { target = "client", ...compilerOptions } = options;
  const transpiled = options.filename.endsWith(".ts")
    ? ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
          inlineSources: true,
          verbatimModuleSyntax: true,
        },
        fileName: options.filename,
      })
    : { outputText: source, sourceMapText: undefined };
  const asset = resultToAsset(
    compileModule(transpiled.outputText, {
      ...compilerOptions,
      filename: options.filename,
      generate: target,
    }),
  );
  if (asset.map && transpiled.sourceMapText)
    asset.map = JSON.stringify(
      remapping(
        [JSON.parse(asset.map), JSON.parse(transpiled.sourceMapText)],
        () => null,
      ),
    );
  return asset;
}

/** Return compiler diagnostics without throwing, useful to development clients. */
export function diagnoseComponent(
  source: string,
  options: Parameters<typeof compileComponent>[1],
): { ok: true; result: CompiledAsset } | { ok: false; error: unknown } {
  try {
    return { ok: true, result: compileComponent(source, options) };
  } catch (error) {
    return { ok: false, error };
  }
}

type VirtualStyle = {
  code: string;
  map: string | null;
  resolveDirectory: string;
};

export type SvelteCompilerPluginOptions = {
  development?: boolean;
  target?: CompilationTarget;
  css?: "external" | "injected";
  hmr?: boolean;
  allowStyleBlock?: (filename: string) => boolean;
  filename?: (filename: string) => string;
  transformServerOutput?: (input: {
    code: string;
    path: string;
    dev: boolean;
  }) => string;
};

/** Return whether a component owns a style block, using Svelte's parser. */
export function hasAuthoredStyleBlock(source: string): boolean {
  return Boolean(parse(source, { modern: true }).css);
}

/** Create the Bun plugin used by browser and server builds. */
export function createSveltePlugin(options: SvelteCompilerPluginOptions = {}) {
  const styles = new Map<string, VirtualStyle>();
  const plugin: Bun.BunPlugin = {
    name: "velveteen-svelte",
    setup(build) {
      build.onResolve({ filter: /^\0velveteen-style:/ }, (args) => ({
        path: `${args.path.slice("\0velveteen-style:".length)}.velveteen.css`,
        namespace: "file",
      }));
      build.onLoad(
        { filter: /\.svelte\.velveteen\.css$/, namespace: "file" },
        (args) => {
          const style = styles.get(args.path);
          if (!style) return;
          return {
            contents: style.code,
            loader: "css",
            resolveDir: style.resolveDirectory,
          };
        },
      );
      build.onLoad({ filter: /\.svelte$/ }, async (args) => {
        const source = await Bun.file(args.path).text();
        if (
          options.allowStyleBlock &&
          hasAuthoredStyleBlock(source) &&
          !options.allowStyleBlock(args.path)
        )
          throw new Error(
            `Svelte style blocks are not allowed in ${args.path}`,
          );
        const filename = options.filename?.(args.path) ?? args.path;
        const development = options.development ?? false;
        const target = options.target ?? "client";
        const css = options.css ?? "external";
        const result = compileComponent(source, {
          filename,
          target,
          dev: development,
          hmr: options.hmr ?? development,
          css,
        });
        if (result.warnings.length)
          throw new Error(
            `Svelte compiler warnings in ${args.path}: ${JSON.stringify(result.warnings)}`,
          );
        const transformed =
          target === "server" && options.transformServerOutput
            ? options.transformServerOutput({
                code: result.code,
                path: args.path,
                dev: development,
              })
            : result.code;
        const sourceMap = result.map
          ? `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(result.map).toString("base64")}`
          : "";
        if (!result.css || target === "server" || css === "injected")
          return { contents: transformed + sourceMap, loader: "js" };
        const stylePath = `\0velveteen-style:${args.path}`;
        styles.set(`${args.path}.velveteen.css`, {
          ...result.css,
          resolveDirectory: dirname(args.path),
        });
        return {
          contents: `${transformed}\nimport ${JSON.stringify(stylePath)};${sourceMap}`,
          loader: "js",
        };
      });
      build.onLoad({ filter: /\.svelte\.[jt]s$/ }, async (args) => {
        const source = await Bun.file(args.path).text();
        const result = compileRuneModule(source, {
          filename: options.filename?.(args.path) ?? args.path,
          target: options.target ?? "client",
          dev: options.development ?? false,
        });
        if (result.warnings.length)
          throw new Error(
            `Svelte compiler warnings in ${args.path}: ${JSON.stringify(result.warnings)}`,
          );
        const sourceMap = result.map
          ? `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(result.map).toString("base64")}`
          : "";
        return { contents: result.code + sourceMap, loader: "js" };
      });
    },
  };
  return plugin;
}
