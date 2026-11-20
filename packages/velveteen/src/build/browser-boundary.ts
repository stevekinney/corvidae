import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

function contains(directory: string, file: string) {
  const path = relative(directory, file);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

/** Guard resolved browser inputs before the compiler loads them, including aliases and re-exports. */
export function createBrowserBoundary(options: {
  projectDirectory: string;
  routesDirectory: string;
  staticDirectory?: string;
}): Bun.BunPlugin {
  return {
    name: "velveteen-browser-boundary",
    async setup(build) {
      const project = await realpath(options.projectDirectory);
      const routes = await realpath(options.routesDirectory);
      const staticDirectory = options.staticDirectory
        ? await realpath(options.staticDirectory)
        : undefined;
      build.onResolve(
        {
          filter:
            /^(?:\$app\/(?:server|env\/private)|\$env\/(?:dynamic|static)\/private)$/,
        },
        (args) => {
          throw new Error(
            `Server-only import ${args.path} from ${args.importer} cannot enter the browser graph`,
          );
        },
      );
      build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
        let path: string;
        try {
          path = await realpath(resolve(args.path));
        } catch (error) {
          // Generated component styles have file-namespace paths so Bun resolves their assets.
          // A missing physical input still fails in Bun's loader; this hook only classifies existing files.
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return;
          throw error;
        }
        if (!contains(project, path)) return;
        const parts = relative(project, path).split(sep);
        if (parts.includes("node_modules")) return;
        const serverFile = /(?:^|[.+])server\./.test(basename(path));
        const serverDirectory =
          parts.slice(0, -1).includes("server") &&
          !contains(routes, path) &&
          !(staticDirectory && contains(staticDirectory, path));
        if (serverFile || serverDirectory)
          throw new Error(
            `Server-only module ${path} cannot enter the browser graph`,
          );
        // An observational hook returns nothing so Bun and the Svelte plugin retain their loaders.
      });
    },
  };
}
