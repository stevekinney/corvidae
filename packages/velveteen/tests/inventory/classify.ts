import { readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

export type PackageScript = {
  package: string;
  name: string;
  command: string;
  runner: string;
  modes: string[];
  status: string;
  owner: string;
};

type Evidence = {
  source: "runtime-import" | "package-script" | "support-convention";
  detail: string;
};

export type TestFileEntry = {
  path: string;
  classification: "executable-test-definition" | "test-support-file";
  runner:
    | "bun"
    | "vitest"
    | "playwright"
    | "typescript"
    | "package-script"
    | "test-support"
    | "unknown";
  modes: string[];
  provenance: Evidence[];
  status: string;
  owner: string;
};

/** One accountable feature batch per source file/script; coverage status is independent. */
export const featureOwner = (path: string, detail = ""): string => {
  const value = `${path} ${detail}`.toLowerCase();
  if (/(prerender|service-worker|adapter-static)/.test(value)) return "H";
  if (/(form-action|remote|enhance|actions?[/.-]|csrf)/.test(value)) return "G";
  if (/packages\/adapter-/.test(path)) return "D";
  if (/(types|routing|matcher|params|route-order|parse_route)/.test(value))
    return "C";
  if (/(build-error|build|asset|manifest|deploy)/.test(value)) return "D";
  if (/(vite|hmr|hot-reload|compile|dev-server)/.test(value)) return "B";
  if (/(client|navigation|scroll|focus|hydrate|preload|history)/.test(value))
    return "F";
  if (
    /(server|load|hook|cookie|fetch|endpoint|serialization|stream)/.test(value)
  )
    return "E";
  if (
    /packages\/kit\/(src|test\/apps)\//.test(path) &&
    !/(configuration|config|package\.json|playwright|vitest|tsconfig)/.test(
      value,
    )
  )
    return "E";
  return "A";
};

const runtimeRunner = (source: string) => {
  if (/\b(?:from\s*["']bun:test["']|require\(\s*["']bun:test)/.test(source))
    return "bun" as const;
  if (/\b(?:from\s*["']vitest["']|require\(\s*["']vitest)/.test(source))
    return "vitest" as const;
  if (
    /\b(?:from\s*["']@playwright\/test["']|require\(\s*["']@playwright\/test)/.test(
      source,
    )
  )
    return "playwright" as const;
  return undefined;
};

const relativeImports = (source: string) =>
  [...source.matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)].map(
    (match) => match[1],
  );

const findRunner = async (
  sourceRoot: string,
  path: string,
  visited = new Set<string>(),
): Promise<{ runner: ReturnType<typeof runtimeRunner>; via: string }> => {
  if (visited.has(path)) return { runner: undefined, via: path };
  visited.add(path);
  let source = "";
  try {
    source = await readFile(resolve(sourceRoot, path), "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("EISDIR"))
      throw error;
  }
  const direct = runtimeRunner(source);
  if (direct) return { runner: direct, via: path };
  for (const imported of relativeImports(source)) {
    const base = join(dirname(path), imported);
    const candidates = extname(base)
      ? [base]
      : [
          base,
          ...[".ts", ".js", ".mjs", ".cjs"].map((ext) => `${base}${ext}`),
          `${base}/index.js`,
        ];
    for (const candidate of candidates) {
      if (!/\.(?:[cm]?[jt]sx?|svelte)$/.test(candidate)) continue;
      const local = relative(sourceRoot, resolve(sourceRoot, candidate));
      if (local === ".." || local.startsWith("../")) continue;
      if (!(await Bun.file(resolve(sourceRoot, candidate)).exists())) continue;
      const result = await findRunner(sourceRoot, candidate, visited);
      if (result.runner) return result;
    }
  }
  return { runner: undefined, via: path };
};

const supportName = (path: string) =>
  /(?:^|\/)(?:utils|helpers|mocks|matchers|fixtures|setup|types)(?:\.[^/]+)?\.[cm]?[jt]sx?$/.test(
    path,
  ) ||
  /(?:^|\/)(?:test|tests)\/.*\/(?:test|playwright)\/(?:test|index)\.[cm]?[jt]sx?$/.test(
    path,
  );

const scriptRunner = (command: string) =>
  /(?:^|\s)playwright(?:\s|$)/.test(command)
    ? "playwright"
    : /\bvitest\b/.test(command)
      ? "vitest"
      : /\bbun\s+test\b/.test(command)
        ? "bun"
        : /\b(?:tsc|svelte-check)\b/.test(command)
          ? "typescript"
          : "package-script";

const scriptModes = (script: PackageScript) =>
  /(?:^|[:\s-])dev(?:$|[:\s-])/.test(`${script.name} ${script.command}`)
    ? ["development"]
    : /(?:^|[:\s-])build(?:$|[:\s-])/.test(`${script.name} ${script.command}`)
      ? ["production"]
      : ["development", "production"];

export const classifyScript = (
  packagePath: string,
  name: string,
  command: string,
): PackageScript => ({
  package: packagePath,
  name,
  command,
  runner: scriptRunner(command),
  modes: scriptModes({
    package: packagePath,
    name,
    command,
    runner: "",
    modes: [],
    status: "reference-only",
    owner: "A",
  }),
  status: "reference-only",
  owner: featureOwner(packagePath, `${name} ${command}`),
});

export const classifyTestFile = async (
  sourceRoot: string,
  path: string,
  scripts: PackageScript[],
): Promise<TestFileEntry> => {
  const runtimeEvidence = await findRunner(sourceRoot, path);
  const runtime = runtimeEvidence.runner;
  let packageDirectory = dirname(path);
  while (packageDirectory !== "." && packageDirectory !== "") {
    if (
      await Bun.file(
        resolve(sourceRoot, packageDirectory, "package.json"),
      ).exists()
    )
      break;
    packageDirectory = dirname(packageDirectory);
  }
  const packageScripts = scripts.filter(
    (script) =>
      script.package ===
      relative(
        sourceRoot,
        resolve(sourceRoot, packageDirectory, "package.json"),
      ),
  );
  const evidence: Evidence[] = runtime
    ? [
        {
          source: "runtime-import",
          detail:
            runtime === runtimeEvidence.runner && runtimeEvidence.via === path
              ? runtime
              : `${runtime} via ${runtimeEvidence.via}`,
        },
      ]
    : packageScripts.length
      ? packageScripts.map((script) => ({
          source: "package-script" as const,
          detail: `${script.package}:${script.name}`,
        }))
      : [];
  const support = supportName(path);
  if (support) evidence.push({ source: "support-convention", detail: path });
  const executable =
    !support &&
    Boolean(runtime || packageScripts.length) &&
    (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || Boolean(runtime));
  const runner = !executable ? "test-support" : (runtime ?? "package-script");
  if (!executable && evidence.length === 0)
    evidence.push({
      source: "support-convention",
      detail: "fixture asset without an executable test definition",
    });
  const modes = packageScripts.length
    ? [...new Set(packageScripts.flatMap(scriptModes).map(String))]
    : ["development", "production"];
  return {
    path,
    classification: executable
      ? "executable-test-definition"
      : "test-support-file",
    runner,
    modes,
    provenance: evidence,
    status: "reference-only",
    owner: featureOwner(path),
  };
};
