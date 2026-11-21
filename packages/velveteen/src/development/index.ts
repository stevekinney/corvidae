import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import remapping from "@jridgewell/remapping";
import { compileComponent, compileRuneModule } from "../compiler/index.ts";

type DevelopmentDiagnostic = {
  filename: string;
  message: string;
  line: number;
  column: number;
};

/** Materialize compiler output so Bun can invalidate CSS separately from JavaScript. */
export async function prepareGeneratedGraph(options: {
  sourceDirectory: string;
  outputDirectory: string;
  files: string[];
}) {
  await mkdir(options.outputDirectory, { recursive: true });
  const diagnostics: DevelopmentDiagnostic[] = [];
  const generatedName = (name: string) =>
    /\.svelte(?:\.[jt]s)?$/.test(name) ? `${name}.generated.js` : name;
  const generatedPaths = new Map(
    options.files.map((name) => [
      resolve(options.sourceDirectory, name),
      resolve(options.outputDirectory, generatedName(name)),
    ]),
  );
  const writeIfChanged = async (path: string, contents: string) => {
    const file = Bun.file(path);
    if ((await file.exists()) && (await file.text()) === contents) return;
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, contents);
  };
  const prepare = async (name: string): Promise<Array<[string, string]>> => {
    const sourcePath = resolve(options.sourceDirectory, name);
    const outputPath = generatedPaths.get(sourcePath)!;
    const source = await Bun.file(sourcePath).text();
    if (!/\.(?:svelte|[jt]s)$/.test(name)) return [[outputPath, source]];
    const asset = name.endsWith(".svelte")
      ? compileComponent(source, {
          filename: sourcePath,
          target: "client",
          dev: true,
          hmr: true,
          css: "external",
          cssHash: () => `velveteen-${Bun.hash(sourcePath).toString(36)}`,
        })
      : /\.svelte\.[jt]s$/.test(name)
        ? compileRuneModule(source, {
            filename: sourcePath,
            target: "client",
            dev: true,
          })
        : { code: source, map: null, css: null, warnings: [] };
    if (asset.warnings.length)
      throw new Error(
        `Compiler warnings in ${sourcePath}: ${JSON.stringify(asset.warnings)}`,
      );
    // Parse module specifiers instead of rewriting arbitrary strings or TypeScript syntax.
    const rewrite: ts.TransformerFactory<ts.SourceFile> = (context) => {
      const visit: ts.Visitor = (node) => {
        if (
          ts.isStringLiteral(node) &&
          (ts.isImportDeclaration(node.parent) ||
            ts.isExportDeclaration(node.parent) ||
            (ts.isCallExpression(node.parent) &&
              node.parent.expression.kind === ts.SyntaxKind.ImportKeyword))
        ) {
          if (
            node.text.startsWith(".") &&
            generatedPaths.has(resolve(dirname(sourcePath), node.text))
          )
            return context.factory.createStringLiteral(
              generatedName(node.text),
            );
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
    };
    const transformed = ts.transpileModule(asset.code, {
      fileName: sourcePath,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        sourceMap: true,
        inlineSources: true,
        verbatimModuleSyntax: true,
      },
      transformers: { before: [rewrite] },
    });
    const files: Array<[string, string]> = [];
    const map = asset.map
      ? JSON.stringify(
          remapping(
            [JSON.parse(transformed.sourceMapText!), JSON.parse(asset.map)],
            () => null,
          ),
        )
      : transformed.sourceMapText!;
    files.push([`${outputPath}.map`, map]);
    // Map contents may change on a CSS edit. The stable URL keeps JavaScript byte-identical.
    let javascript = transformed.outputText.replace(
      /^\/\/# sourceMappingURL=.*$/m,
      "",
    );
    if (asset.css) {
      const stylesheet = `${name}.css`;
      files.push([join(options.outputDirectory, stylesheet), asset.css.code]);
      javascript += `\nimport ${JSON.stringify(`./${stylesheet.split("/").at(-1)}`)};\n`;
    }
    javascript += `\n//# sourceMappingURL=${outputPath.split("/").at(-1)}.map\n`;
    files.push([outputPath, javascript]);
    return files;
  };
  const publish = async (initial = false) => {
    try {
      // Compile the complete fixture before changing any published artifact.
      const preparedFiles = await Promise.all(options.files.map(prepare));
      const files = preparedFiles.flat();
      for (const [path, contents] of files)
        await writeIfChanged(path, contents);
    } catch (error) {
      if (initial) throw error;
      const located = error as {
        filename?: string;
        message?: string;
        start?: { line: number; column: number };
      };
      diagnostics.push({
        filename: located.filename ?? options.sourceDirectory,
        message: located.message ?? String(error),
        line: located.start?.line ?? 0,
        column: located.start?.column ?? 0,
      });
    }
  };
  await publish(true);
  let pending = Promise.resolve();
  const watcher = watch(
    options.sourceDirectory,
    { recursive: true },
    (_event, filename) => {
      if (filename && options.files.includes(filename))
        pending = pending.then(() => publish());
    },
  );
  return {
    diagnostics,
    async close() {
      watcher.close();
      await pending;
    },
  };
}
