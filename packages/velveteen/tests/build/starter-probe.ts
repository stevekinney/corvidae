import { chromium } from "playwright";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { catalogConsumerFiles } from "./catalog-consumer-fixture.ts";
import { stageCatalogPackages } from "./catalog-consumer-stage.ts";

const repository = resolve(
  process.argv[2] ?? resolve(import.meta.dir, "../.."),
);
const directory = await mkdtemp(join(tmpdir(), "velveteen-starter-"));
const application = join(directory, "application");
const occupied = join(directory, "occupied");
const run = (command: string[], cwd: string, env?: Record<string, string>) =>
  Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
const output = (result: ReturnType<typeof run>) =>
  `${result.stdout.toString()}\n${result.stderr.toString()}`;
const assertSuccess = (label: string, result: ReturnType<typeof run>) => {
  if (result.exitCode !== 0)
    throw new Error(`${label} failed:\n${output(result)}`);
};
const assertFailure = (label: string, result: ReturnType<typeof run>) => {
  if (result.exitCode === 0) throw new Error(`${label} unexpectedly succeeded`);
};

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const children: Bun.Subprocess[] = [];
const observations: Record<string, unknown> = {};
try {
  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, "sentinel"), "do not overwrite\n");
  await mkdir(join(occupied, ".velveteen"));
  await writeFile(join(occupied, ".velveteen", "sentinel"), "keep state\n");

  const refused = run(
    [process.execPath, "run", "create", occupied],
    repository,
  );
  assertFailure("non-empty destination refusal", refused);
  if (
    (await readFile(join(occupied, "sentinel"), "utf8")) !==
      "do not overwrite\n" ||
    (await readFile(join(occupied, ".velveteen", "sentinel"), "utf8")) !==
      "keep state\n" ||
    (await readdir(occupied)).sort().join(",") !== ".velveteen,sentinel"
  )
    throw new Error("non-empty destination was modified");

  await mkdir(application);
  if ((await readdir(application)).length !== 0)
    throw new Error("starter destination was not empty before generation");

  const creators = Array.from({ length: 2 }, () =>
    Bun.spawn([process.execPath, "run", "create", application], {
      cwd: repository,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const results = await Promise.all(
    creators.map(async (child) => ({
      exit: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })),
  );
  if (results.filter(({ exit }) => exit === 0).length !== 1)
    throw new Error(
      `concurrent starter creation must admit one writer: ${JSON.stringify(results)}`,
    );
  observations.concurrentCreation = "one writer";
  const generatedPackage = JSON.parse(
    await readFile(join(application, "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
  };
  for (const script of ["check", "dev", "build", "start"])
    if (!generatedPackage.scripts?.[script])
      throw new Error(`generated package is missing ${script} script`);

  const packageRoot = await realpath(repository);
  const installed = run([process.execPath, "install"], application);
  assertSuccess("generated application install", installed);
  const packageName = JSON.parse(
    await readFile(join(repository, "package.json"), "utf8"),
  ) as { name: string };
  const resolvedPackage = Bun.resolveSync(
    `${packageName.name}/compiler`,
    join(application, "package.json"),
  );
  if (resolvedPackage.startsWith(packageRoot))
    throw new Error(
      `generated app resolves the source package: ${resolvedPackage}`,
    );
  observations.packageResolution = resolvedPackage;

  const archives = await stageCatalogPackages(repository, directory);
  for (const [name, entry, forbidden] of [
    ["velveteen", "@lostgradient/velveteen/server", /backchannel|armorer/i],
    ["backchannel", "@lostgradient/backchannel", /velveteen|armorer/i],
    ["armorer", "armorer/mcp/http", /velveteen|backchannel/i],
  ] as const) {
    for (const production of [false, true]) {
      const consumer = join(directory, `${name}-${production ? "production" : "development"}`);
      await mkdir(consumer);
      const dependencies = name === "velveteen"
        ? { "@lostgradient/velveteen": `file:${join(application, ".velveteen/velveteen.tgz")}`, svelte: "5.57.1" }
        : { [name === "armorer" ? "armorer" : "@lostgradient/backchannel"]: `file:${archives[name === "armorer" ? "armorer" : "@lostgradient/backchannel"]}` };
      await writeFile(join(consumer, "package.json"), JSON.stringify({ name: `independent-${name}`, private: true, type: "module", dependencies }));
      assertSuccess(`${name} isolated installation`, run([process.execPath, "install", "--ignore-scripts", ...(production ? ["--production"] : [])], consumer));
      assertSuccess(`${name} isolated public import`, run([process.execPath, "-e", `await import(${JSON.stringify(entry)})`], consumer));
      for await (const path of new Bun.Glob("**/package.json").scan({ cwd: join(consumer, "node_modules"), onlyFiles: true })) {
        const installed = JSON.parse(await readFile(join(consumer, "node_modules", path), "utf8")) as { name?: string };
        if (installed.name && forbidden.test(installed.name)) throw new Error(`${name} acquired provider dependency ${installed.name}`);
      }
    }
  }
  for (const production of [false, true]) {
    const consumer = join(directory, `composition-${production ? "production" : "development"}`);
    await mkdir(consumer);
    const dependencies: Record<string, string> = {
      "@lostgradient/velveteen": `file:${join(application, ".velveteen/velveteen.tgz")}`,
      "@tanstack/svelte-query": "^6.2.1",
      svelte: "5.57.1",
    };
    for (const [name, archive] of Object.entries(archives)) dependencies[name] = `file:${archive}`;
    const manifest = join(consumer, "package.json");
    await writeFile(manifest, JSON.stringify({ name: "composition-consumer", private: true, type: "module", dependencies }));
    assertSuccess("clean composition installation", run([process.execPath, "install", "--ignore-scripts", ...(production ? ["--production"] : [])], consumer));
    for (const entry of ["@lostgradient/velveteen/server", "@lostgradient/backchannel", "@lostgradient/backchannel-mcp", "@lostgradient/backchannel-armorer", "armorer/mcp/http"]) {
      const resolved = await realpath(Bun.resolveSync(entry, manifest));
      if (!resolved.startsWith(await realpath(consumer))) throw new Error(`composition import escaped consumer: ${entry}`);
      assertSuccess(`composition import ${entry}`, run([process.execPath, "-e", `await import(${JSON.stringify(entry)})`], consumer));
    }
  }
  const appManifestPath = join(application, "package.json");
  const appManifest = JSON.parse(await readFile(appManifestPath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  for (const [name, archive] of Object.entries(archives))
    appManifest.dependencies[name] = `file:${archive}`;
  appManifest.dependencies["@tanstack/svelte-query"] = "^6.2.1";
  appManifest.dependencies["@modelcontextprotocol/client"] = "2.4.0";
  appManifest.dependencies.zod = "^4.6.6";
  await writeFile(appManifestPath, JSON.stringify(appManifest, null, 2));
  assertSuccess(
    "catalog package installation",
    run([process.execPath, "install"], application),
  );
  for (const entry of [
    "@lostgradient/backchannel",
    "@lostgradient/backchannel/generator",
    "@lostgradient/backchannel/client",
    "@lostgradient/backchannel-svelte",
  ]) {
    const resolvedEntry = await realpath(
      Bun.resolveSync(entry, appManifestPath),
    );
    if (!resolvedEntry.startsWith(await realpath(application)))
      throw new Error(
        `catalog entry resolved outside the installed consumer: ${entry}`,
      );
  }
  for (const [path, contents] of Object.entries(catalogConsumerFiles)) {
    const destination = join(application, path);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, contents);
  }
  assertSuccess(
    "installed equipment MCP probe",
    run([process.execPath, "probe/equipment.ts"], application),
  );
  assertSuccess(
    "installed remote OAuth probe",
    run([process.execPath, "probe/remote.ts"], application),
  );
  assertSuccess(
    "catalog generation",
    run([process.execPath, "src/generate.ts"], application, {
      EXTRA_OPERATION: "",
    }),
  );

  const installedManifest = JSON.parse(
    await readFile(
      join(application, "node_modules", packageName.name, "package.json"),
      "utf8",
    ),
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const dependencies = Object.keys({
    ...installedManifest.dependencies,
    ...installedManifest.peerDependencies,
  });
  if (
    dependencies.some((name) =>
      /(?:backchannel|armorer|bureau|modelcontextprotocol)/i.test(name),
    )
  )
    throw new Error("Velveteen has a provider dependency");
  const serverSource = join(application, "src/server.ts");
  const serverText = await readFile(serverSource, "utf8");
  if (!serverText.includes("createApplication({ generation })"))
    throw new Error("starter application entry changed");
  await writeFile(
    serverSource,
    `import { createOperationHandler, principalFromApiKey } from '@lostgradient/backchannel';\nimport { createOperationMcpMount } from '@lostgradient/backchannel-mcp';\nimport { createMCP, createToolbox } from 'armorer';\nimport { operations, state } from './catalog.ts';\nimport { equipment, lookup, operations as equipmentOperations } from './equipment.ts';\n` +
      serverText.replace(
        "createApplication({ generation })",
        `createApplication({ generation, mounts: { '/native': async () => { const native = await createMCP(createToolbox([lookup])); return { fetch: (request) => request.headers.get('cookie')?.includes('actor=1') ? native.fetch(request) : new Response(null, { status: 401 }), close: native.close }; }, '/service': () => { const handler = createOperationHandler({ operations: [...operations, ...equipmentOperations], mounts: [createOperationMcpMount({ serverInfo: { name: 'equipment', version: '1' } })], host: {}, authenticate: async (request) => request.headers.get('cookie')?.includes('actor=1') ? { method: 'api-key', principal: principalFromApiKey({ subject: 'actor', scopes: ['equipment:read', 'equipment:write'] }) } : new Response('denied', { status: 401 }) }); return (request) => { const url = new URL(request.url); if (url.pathname === '/control') { if (url.searchParams.has('release')) state.release.resolve(); return new Response(JSON.stringify({ reads: state.reads, inspections: state.inspections, commands: state.commands, aborted: state.aborted, settledA: state.settledA, equipment })); } return handler(request); }; } } })`,
      ),
  );
  const unchangedPaths = [serverSource, join(application, "src/transport.ts")];
  const beforeGeneration = await Promise.all(
    unchangedPaths.map((path) => readFile(path, "utf8")),
  );
  const generatedBinding = join(
    application,
    "src/generated/operation-client.svelte.ts",
  );
  const originalBinding = await readFile(generatedBinding, "utf8");
  const sourceTree = async () => {
    const files: Record<string, string> = {};
    for await (const path of new Bun.Glob("**/*").scan({ cwd: join(application, "src"), onlyFiles: true })) {
      if (!path.startsWith("generated/"))
        files[path] = await readFile(join(application, "src", path), "utf8");
    }
    return files;
  };
  const beforeSource = await sourceTree();
  const catalogPath = join(application, "src/catalog.ts");
  const catalogSource = await readFile(catalogPath, "utf8");
  if (!catalogSource.includes("export const operations = [read, command];"))
    throw new Error("catalog declaration changed");
  await writeFile(catalogPath, catalogSource.replace(
    "export const operations = [read, command];",
    "export const operations = [read, command, extra];",
  ));
  assertSuccess(
    "extended catalog generation",
    run([process.execPath, "src/generate.ts"], application, {
      EXTRA_OPERATION: "1",
    }),
  );
  const afterGeneration = await Promise.all(
    unchangedPaths.map((path) => readFile(path, "utf8")),
  );
  const afterSource = await sourceTree();
  const changedSources = [...new Set([...Object.keys(beforeSource), ...Object.keys(afterSource)])]
    .filter((path) => beforeSource[path] !== afterSource[path]);
  if (changedSources.length !== 1 || changedSources[0] !== "catalog.ts")
    throw new Error(`unexpected source edits: ${changedSources.join(", ")}`);
  if (
    beforeGeneration.some((source, index) => source !== afterGeneration[index])
  )
    throw new Error("catalog generation changed the transport or router");
  const extendedBinding = await readFile(generatedBinding, "utf8");
  if (
    originalBinding.includes("useEquipmentItemsInspect") ||
    !extendedBinding.includes("useEquipmentItemsInspect")
  )
    throw new Error("regeneration did not add the Svelte operation");

  const checked = run([process.execPath, "run", "check"], application);
  assertSuccess("generated application check", checked);
  const pageLoad = join(application, "src/routes/+page.ts");
  const pageLoadSource = await readFile(pageLoad, "utf8");
  try {
    await writeFile(
      pageLoad,
      pageLoadSource + '\nconst malformed: number = "starter type control";\n',
    );
    const invalid = run([process.execPath, "run", "check"], application);
    assertFailure("generated application TypeScript control", invalid);
    if (!output(invalid).includes("TS2322"))
      throw new Error(
        `expected TypeScript diagnostic TS2322:\n${output(invalid)}`,
      );
  } finally {
    await writeFile(pageLoad, pageLoadSource);
  }
  observations.check = { valid: "passed", invalid: "TS2322" };

  const start = async (
    script: "dev" | "start",
    extraEnvironment?: Record<string, string>,
  ) => {
    const child = Bun.spawn([process.execPath, "run", script], {
      cwd: application,
      env: { ...process.env, PORT: "0", ...extraEnvironment },
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    const ready = Promise.withResolvers<{ url: string; mode: string }>();
    const consume = async () => {
      for await (const chunk of child.stdout) {
        stdout += new TextDecoder().decode(chunk);
        for (const line of stdout.split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          try {
            const value = JSON.parse(line) as unknown;
            if (
              value &&
              typeof value === "object" &&
              "url" in value &&
              typeof value.url === "string" &&
              "mode" in value &&
              typeof value.mode === "string"
            )
              ready.resolve(value as { url: string; mode: string });
          } catch {
            // Ignore non-protocol output from the application.
          }
        }
      }
    };
    const consumeErrors = (async () => {
      for await (const chunk of child.stderr)
        stderr += new TextDecoder().decode(chunk);
    })();
    void consume();
    void consumeErrors;
    const timer = setTimeout(
      () =>
        ready.reject(
          new Error(`${script} readiness timed out\n${stdout}\n${stderr}`),
        ),
      10000,
    );
    void child.exited.then((exit) =>
      ready.reject(new Error(`${script} exited ${exit}\n${stdout}\n${stderr}`)),
    );
    try {
      const value = await ready.promise;
      return { child, value, stdout: () => stdout, stderr: () => stderr };
    } finally {
      clearTimeout(timer);
    }
  };

  const dev = await start("dev", { EXTRA_OPERATION: "1" });
  if ((await fetch(new URL("/service/control", dev.value.url))).status !== 200)
    throw new Error("development mount failed");
  if (dev.value.mode !== "development")
    throw new Error(`dev mode mismatch: ${dev.value.mode}`);
  assertSuccess(
    "development mounted MCP services",
    run([process.execPath, "probe/mounted.ts", dev.value.url], application),
  );
  browser = await chromium.launch({ headless: true });
  const devPage = await browser.newPage();
  const diagnostics: string[] = [];
  devPage.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      diagnostics.push(message.text());
  });
  devPage.on("pageerror", (error) => diagnostics.push(String(error)));
  const response = await devPage.goto(dev.value.url, {
    waitUntil: "networkidle",
  });
  if (response?.status() !== 200)
    throw new Error(`dev HTTP status ${response?.status()}`);
  if ((await devPage.title()) !== "Velveteen starter")
    throw new Error("starter SSR title mismatch");
  const button = devPage.locator("button");
  const initial = await button.textContent();
  await button.click();
  const afterClick = await button.textContent();
  if (initial !== "Count: 0" || afterClick !== "Count: 1")
    throw new Error("starter hydration interaction did not update");
  if (diagnostics.length)
    throw new Error(`browser diagnostics: ${diagnostics.join(" | ")}`);
  await devPage.close();
  const catalogPage = await browser.newPage();
  const catalogDiagnostics: string[] = [];
  catalogPage.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      catalogDiagnostics.push(message.text());
  });
  catalogPage.on("pageerror", (error) =>
    catalogDiagnostics.push(String(error)),
  );
  await catalogPage
    .context()
    .addCookies([{ name: "actor", value: "1", url: dev.value.url }]);
  const catalogResponse = await catalogPage.goto(
    new URL("/items/initial", dev.value.url).href,
    { waitUntil: "networkidle" },
  );
  if (!(await catalogResponse!.text()).includes('id="item">initial'))
    throw new Error("protected SSR did not render the catalog item");
  await catalogPage.locator("#item").waitFor();
  await catalogPage.waitForFunction(
    () => document.querySelector("#inspection")?.textContent === "initial",
  );
  const control = async () =>
    (await (
      await fetch(new URL("/service/control", dev.value.url))
    ).json()) as {
      reads: string[];
      inspections: number;
      commands: number;
      aborted: boolean;
      settledA: boolean;
      equipment: { reads: number; writes: number; name: string };
    };
  const hydrated = await control();
  if (hydrated.reads.join(",") !== "initial" || hydrated.inspections < 2)
    throw new Error(
      `hydration or regenerated operation mismatch: ${JSON.stringify(hydrated)}`,
    );
  await catalogPage.locator("#reserve").click();
  await catalogPage.waitForFunction(
    () => document.querySelector("#fault")?.textContent === "unknown",
  );
  if ((await control()).commands !== 1)
    throw new Error("ambiguous command was replayed");
  await catalogPage
    .locator('a[href="/items/A"]')
    .evaluate((link: HTMLAnchorElement) => link.click());
  await catalogPage.waitForFunction(async () =>
    (await (await fetch("/service/control")).json()).reads.includes("A"),
  );
  await catalogPage
    .locator('a[href="/items/B"]')
    .evaluate((link: HTMLAnchorElement) => link.click());
  await catalogPage.waitForFunction(
    () => document.querySelector("#item")?.textContent === "B",
  );
  await catalogPage.waitForFunction(
    async () => (await (await fetch("/service/control")).json()).aborted,
  );
  await fetch(new URL("/service/control?release=1", dev.value.url));
  await catalogPage.waitForFunction(
    async () => (await (await fetch("/service/control")).json()).settledA,
  );
  await catalogPage.waitForLoadState("networkidle");
  if ((await catalogPage.locator("#item").textContent()) !== "B")
    throw new Error("late A result replaced B");
  if (catalogDiagnostics.length)
    throw new Error(
      `catalog browser diagnostics: ${catalogDiagnostics.join(" | ")}`,
    );
  const finalCatalog = await control();
  if (
    finalCatalog.reads.join(",") !== "initial,A,B" ||
    finalCatalog.commands !== 1
  )
    throw new Error(
      `catalog requests were duplicated: ${JSON.stringify(finalCatalog)}`,
    );
  observations.catalog = {
    hydrated,
    final: finalCatalog,
    regeneration: "transport and router unchanged",
  };
  const beforeEquipment = (await control()).equipment;
  const equipmentResponse = await catalogPage.goto(
    new URL("/equipment", dev.value.url).href,
    { waitUntil: "networkidle" },
  );
  if (!(await equipmentResponse!.text()).includes("Camera"))
    throw new Error("equipment SSR did not render the initial name");
  const loadedEquipment = (await control()).equipment;
  if (loadedEquipment.reads !== beforeEquipment.reads + 1)
    throw new Error("equipment SSR lookup invoked an unexpected number of times");
  await catalogPage.locator("#equipment-rename").click();
  await catalogPage.waitForFunction(
    () => document.querySelector("#equipment-name")?.textContent === "Studio camera",
  );
  const renamedEquipment = (await control()).equipment;
  if (renamedEquipment.writes !== loadedEquipment.writes + 1)
    throw new Error("equipment rename invoked an unexpected number of times");
  const scriptClient = run(
    [process.execPath, "probe/read-equipment.ts", dev.value.url],
    application,
  );
  assertSuccess("generated equipment client", scriptClient);
  if ((await control()).equipment.reads !== renamedEquipment.reads + 1)
    throw new Error("generated equipment client invoked an unexpected number of times");
  observations.equipment = JSON.parse(scriptClient.stdout.toString());
  await catalogPage.close();
  dev.child.kill("SIGTERM");
  await dev.child.exited;
  observations.development = { mode: dev.value.mode, initial, afterClick };

  const built = run([process.execPath, "run", "build"], application);
  assertSuccess("generated application build", built);
  const generations = join(application, ".velveteen/production/generations");
  let inspectedBrowserBundle = false;
  for await (const file of new Bun.Glob("*/build-metadata.json").scan({
    cwd: generations,
    absolute: true,
  })) {
    const metadata = JSON.parse(await readFile(file, "utf8")) as {
      browser: { inputs: Record<string, unknown> };
    };
    inspectedBrowserBundle ||= Object.keys(metadata.browser.inputs).some(
      (input) => input.endsWith("src/generated/operation-client.svelte.ts"),
    );
    const forbidden = Object.keys(metadata.browser.inputs).filter(
      (input) =>
        input.endsWith("src/equipment.ts") ||
        input.includes("node_modules/armorer/") ||
        input.includes("node_modules/@lostgradient/backchannel-armorer/") ||
        input.includes("node_modules/@lostgradient/backchannel-mcp/") ||
        (input.includes("node_modules/@lostgradient/backchannel/") &&
          !input.includes("/src/client/")),
    );
    if (forbidden.length)
      throw new Error(
        `server catalog code in browser bundle: ${forbidden.join(", ")}`,
      );
  }
  if (!inspectedBrowserBundle)
    throw new Error(
      "generated Svelte binding missing from browser bundle metadata",
    );
  await rename(join(application, "src/routes"), join(directory, "routes"));
  const production = await start("start", {
    NODE_ENV: "production",
    EXTRA_OPERATION: "1",
  });
  if (
    (await fetch(new URL("/service/control", production.value.url))).status !==
    200
  )
    throw new Error("production mount failed");
  if (production.value.mode !== "production")
    throw new Error(`start mode mismatch: ${production.value.mode}`);
  assertSuccess(
    "production mounted MCP services",
    run([process.execPath, "probe/mounted.ts", production.value.url], application),
  );
  const productionResponse = await fetch(production.value.url);
  if (productionResponse.status !== 200)
    throw new Error(`production HTTP status ${productionResponse.status}`);
  if (
    !(await productionResponse.text()).includes(
      "<title>Velveteen starter</title>",
    )
  )
    throw new Error("production SSR title missing");
  const productionEquipment = await browser.newPage();
  await productionEquipment.context().addCookies([
    { name: "actor", value: "1", url: production.value.url },
  ]);
  const productionPage = await productionEquipment.goto(
    new URL("/equipment", production.value.url).href,
    { waitUntil: "networkidle" },
  );
  if (!(await productionPage!.text()).includes("Camera"))
    throw new Error("production equipment SSR did not render");
  await productionEquipment.locator("#equipment-rename").click();
  await productionEquipment.waitForFunction(
    () => document.querySelector("#equipment-name")?.textContent === "Studio camera",
  );
  assertSuccess(
    "production generated equipment client",
    run([process.execPath, "probe/read-equipment.ts", production.value.url], application),
  );
  await productionEquipment.close();
  production.child.kill("SIGTERM");
  await production.child.exited;
  observations.production = {
    mode: production.value.mode,
    status: productionResponse.status,
  };
} finally {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
    await child.exited.catch(() => undefined);
  }
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
if (existsSync(directory))
  throw new Error("starter temporary directory was not removed");
console.log(
  JSON.stringify({
    observations,
    cleanup: {
      directoryRemoved: !existsSync(directory),
      browserClosed: browser === undefined || !browser.isConnected(),
    },
  }),
);
