import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? resolve(import.meta.dir, "../.."));
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as { name: string; version: string };
const packageName = packageJson.name;
const sourceSha256 = createHash("sha256")
  .update(await readFile(join(root, "package.json")))
  .update(await readFile(join(root, "src/compiler/index.ts")))
  .digest("hex");
const evidenceDirectory = join(root, ".velveteen/evidence");

const run = (command: string[], cwd: string) =>
  Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });

const packageVersion = async (resolved: string) => {
  let current = dirname(resolved);
  while (current !== dirname(current)) {
    const candidate = join(current, "package.json");
    if (await Bun.file(candidate).exists()) {
      const value = JSON.parse(await Bun.file(candidate).text()) as {
        name?: string;
        version?: string;
      };
      if (value.name === "svelte") return value.version;
    }
    current = dirname(current);
  }
  throw new Error(`Could not find Svelte package for ${resolved}`);
};

const directory = await mkdtemp(join(tmpdir(), "velveteen-package-consumer-"));
const tarball = join(directory, "velveteen.tgz");
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let evidence: Record<string, unknown> | undefined;
let summary: Record<string, unknown> | undefined;
let serverStopResolved = false;
try {
  const packed = run(
    [process.execPath, "pm", "pack", "--ignore-scripts", "--filename", tarball],
    root,
  );
  if (packed.exitCode !== 0)
    throw new Error(`bun pm pack failed:\n${packed.stderr.toString()}`);
  const tarballSha256 = createHash("sha256")
    .update(Buffer.from(await Bun.file(tarball).arrayBuffer()))
    .digest("hex");

  await Bun.write(
    join(directory, "package.json"),
    JSON.stringify({
      name: "velveteen-unrelated-consumer",
      type: "module",
      private: true,
      dependencies: {
        [packageName]: tarball,
        svelte: "5.57.1",
        typescript: "6.0.3",
      },
    }),
  );
  const installed = run(
    [process.execPath, "install", "--ignore-scripts"],
    directory,
  );
  if (installed.exitCode !== 0)
    throw new Error(`bun install failed:\n${installed.stderr.toString()}`);

  const sourceDirectory = join(directory, "src");
  await mkdir(sourceDirectory, { recursive: true });
  await Bun.write(
    join(sourceDirectory, "App.svelte"),
    `<script>import { counter } from './counter.svelte.ts'; const state = counter();</script><button id="counter" onclick={() => state.increment()}>Count: {state.value}</button><style>button { color: rgb(1, 2, 3); }</style>`,
  );
  await Bun.write(
    join(sourceDirectory, "counter.svelte.ts"),
    `export function counter() { let value = $state(3); return { get value() { return value; }, increment() { value += 1; } }; }`,
  );
  await Bun.write(
    join(sourceDirectory, "client.ts"),
    `import { mount } from 'svelte'; import App from './App.svelte'; mount(App, { target: document.getElementById('app')! });`,
  );
  await Bun.write(
    join(sourceDirectory, "server.ts"),
    `import { render } from 'svelte/server'; import App from './App.svelte'; export const rendered = render(App);`,
  );
  await Bun.write(
    join(sourceDirectory, "runtime.ts"),
    `import App from './App.svelte'; import { counter } from './counter.svelte.ts'; export const probe = { App, value: counter().value };`,
  );
  const applicationDirectory = join(directory, "application");
  await mkdir(applicationDirectory, { recursive: true });

  const probe = join(directory, "probe.ts");
  await Bun.write(
    probe,
    await readFile(join(import.meta.dir, "package-consumer-build.ts"), "utf8"),
  );
  const child = run(
    [process.execPath, "--no-install", probe, `${packageName}/compiler`],
    directory,
  );
  if (child.exitCode !== 0)
    throw new Error(
      `consumer probe failed:\n${child.stderr.toString()}\n${child.stdout.toString()}`,
    );
  const childOutput = child.stdout.toString().trim().split("\n").at(-1);
  if (!childOutput) throw new Error("consumer probe emitted no result");
  const result = JSON.parse(childOutput) as {
    clientOutputs: number;
    serverOutputs: number;
    rendered: string;
    runtime: number;
    compilerSvelte: string;
    consumerSvelte: string;
    clientEntry: string;
    applications: Array<{
      development: boolean;
      outdir: string;
      metafile: Bun.BuildMetafile;
      outputs: Array<{ path: string; bytes: number; sha256: string }>;
      maps: string[];
      wasmAsset: string;
      html: string;
      buildLogs: string[];
    }>;
  };
  const [compilerSveltePath, consumerSveltePath] = await Promise.all([
    realpath(result.compilerSvelte),
    realpath(result.consumerSvelte),
  ]);
  const [compilerVersion, consumerVersion] = await Promise.all([
    packageVersion(compilerSveltePath),
    packageVersion(consumerSveltePath),
  ]);
  if (compilerVersion !== "5.57.1" || consumerVersion !== "5.57.1")
    throw new Error(
      `Svelte version mismatch: ${compilerVersion}/${consumerVersion}`,
    );
  if (compilerSveltePath !== consumerSveltePath)
    throw new Error(
      `Svelte resolved twice: ${compilerSveltePath}/${consumerSveltePath}`,
    );

  let activeDirectory = join(directory, "client");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname.slice(1) || "index.html";
      const file = Bun.file(join(activeDirectory, path));
      return (await file.exists())
        ? new Response(file)
        : new Response("Not found", { status: 404 });
    },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const messages: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      messages.push(message.text());
  });
  page.on("pageerror", (error) => messages.push(String(error)));
  await page.goto(server.url.href, { waitUntil: "networkidle" });
  if ((await page.locator("#counter").textContent()) !== "Count: 3")
    throw new Error("browser initial literal mismatch");
  if (
    (await page
      .locator("#counter")
      .evaluate((node) => getComputedStyle(node).color)) !== "rgb(1, 2, 3)"
  )
    throw new Error("browser CSS mismatch");
  await page.locator("#counter").click();
  if ((await page.locator("#counter").textContent()) !== "Count: 4")
    throw new Error("browser rune increment mismatch");
  if (messages.length)
    throw new Error(`browser console diagnostics: ${messages.join(" | ")}`);

  const applicationObservations: Array<Record<string, unknown>> = [];
  for (const application of result.applications) {
    activeDirectory = application.outdir;
    const applicationPage = await browser.newPage();
    const applicationDiagnostics: string[] = [];
    const lazyRequests: string[] = [];
    const assetRequests: string[] = [];
    const emittedAssets = application.outputs
      .filter(
        (output) =>
          !output.path.endsWith(".html") && !output.path.endsWith(".map"),
      )
      .map((output) => relative(application.outdir, output.path));
    if (
      emittedAssets.length < 3 ||
      emittedAssets.some(
        (path) => !/^assets\/.+-[a-z0-9]{8}\.(?:js|css|wasm)$/.test(path),
      )
    )
      throw new Error(
        `Expected hashed application assets: ${emittedAssets.join(", ")}`,
      );
    applicationPage.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        applicationDiagnostics.push(message.text());
    });
    applicationPage.on("pageerror", (error) =>
      applicationDiagnostics.push(String(error)),
    );
    applicationPage.on("requestfailed", (request) =>
      applicationDiagnostics.push(`request failed: ${request.url()}`),
    );
    applicationPage.on("response", (response) => {
      if (response.status() >= 400)
        applicationDiagnostics.push(
          `HTTP ${response.status()}: ${response.url()}`,
        );
    });
    applicationPage.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path !== "/") assetRequests.push(path);
      if (request.url().includes("lazy-")) lazyRequests.push(request.url());
    });
    const documentResponse = await applicationPage.goto(server.url.href, {
      waitUntil: "networkidle",
    });
    const documentStatus = documentResponse?.status();
    if (documentStatus !== 200)
      throw new Error("Native HTML entry was not served");
    if ((await applicationPage.locator("#counter").count()) !== 1)
      throw new Error(
        `application did not mount: ${applicationDiagnostics.join(" | ")}`,
      );
    if (
      (await applicationPage.locator("#counter").textContent()) !== "Count: 1"
    )
      throw new Error("application initial counter mismatch");
    if (
      (await applicationPage.locator("#derived").textContent()) !== "Double: 2"
    )
      throw new Error("application derived value mismatch");
    if (
      (await applicationPage.locator("#resolver").textContent()) !==
      "Resolver: fixture-resolver-value"
    )
      throw new Error("application resolver value mismatch");
    if ((await applicationPage.locator("#wasm").textContent()) !== "WASM: 5")
      throw new Error("application WASM value mismatch");
    const expectedMode = application.development ? "development" : "production";
    if (
      (await applicationPage.locator("#mode").textContent()) !==
      `Mode: ${expectedMode}`
    )
      throw new Error("application NODE_ENV mismatch");
    if (
      (await applicationPage
        .locator(".card")
        .evaluate((node) => getComputedStyle(node).color)) !== "rgb(9, 8, 7)"
    )
      throw new Error("application component CSS mismatch");
    const initial = {
      counter: await applicationPage.locator("#counter").textContent(),
      derived: await applicationPage.locator("#derived").textContent(),
      resolver: await applicationPage.locator("#resolver").textContent(),
      wasm: await applicationPage.locator("#wasm").textContent(),
      css: await applicationPage
        .locator(".card")
        .evaluate((node) => getComputedStyle(node).color),
      mode: await applicationPage.locator("#mode").textContent(),
    };
    if (lazyRequests.length !== 0)
      throw new Error("lazy module requested before action");
    await applicationPage.locator("#increment").click();
    if (
      (await applicationPage.locator("#counter").textContent()) !== "Count: 2"
    )
      throw new Error("application increment mismatch");
    if (
      (await applicationPage.locator("#derived").textContent()) !== "Double: 4"
    )
      throw new Error("application derived update mismatch");
    const lazyRequest = applicationPage.waitForRequest((request) =>
      request.url().includes("lazy-"),
    );
    await applicationPage.locator("#lazy").click();
    await lazyRequest;
    await applicationPage.waitForFunction(
      () =>
        document.querySelector("#lazy-result")?.textContent === "Lazy: loaded",
    );
    if (
      (await applicationPage.locator("#lazy-result").textContent()) !==
      "Lazy: loaded"
    )
      throw new Error(
        `application lazy result mismatch: ${await applicationPage.locator("#lazy-result").textContent()}`,
      );
    if (lazyRequests.length === 0)
      throw new Error("lazy module was not requested after action");
    if (applicationDiagnostics.length)
      throw new Error(
        `application diagnostics: ${applicationDiagnostics.join(" | ")}`,
      );
    if (assetRequests.some((path) => !emittedAssets.includes(path.slice(1))))
      throw new Error(
        `Requested asset was not emitted: ${assetRequests.join(", ")}`,
      );
    const afterActions = {
      counter: await applicationPage.locator("#counter").textContent(),
      derived: await applicationPage.locator("#derived").textContent(),
      lazy: await applicationPage.locator("#lazy-result").textContent(),
      lazyRequests: lazyRequests.length,
    };
    await applicationPage.close();
    applicationObservations.push({
      mode: application.development ? "development" : "production",
      documentStatus,
      initial,
      afterActions,
      emittedAssets,
      assetRequests,
      maps: application.maps,
      wasmAsset: application.wasmAsset,
      outputHashes: application.outputs,
      metafileOutputs: Object.keys(application.metafile.outputs),
      diagnostics: applicationDiagnostics,
      buildLogs: application.buildLogs,
    });
  }

  evidence = {
    package: {
      name: packageName,
      version: packageJson.version,
      sourceSha256,
      tarballSha256,
    },
    child: {
      ...result,
      compilerSvelte: compilerSveltePath,
      consumerSvelte: consumerSveltePath,
      compilerVersion,
      consumerVersion,
    },
    observed: {
      ssrLiteral: result.rendered.includes("Count: 3"),
      runtimeRuneValue: result.runtime,
      browserInitial: "Count: 3",
      browserAfterClick: "Count: 4",
      computedColor: "rgb(1, 2, 3)",
      consoleDiagnostics: messages,
      applications: applicationObservations,
    },
  };
  summary = {
    tarballSha256,
    compilerSvelte: compilerSveltePath,
    consumerSvelte: consumerSveltePath,
    browser: "Count: 3 -> Count: 4",
    css: "rgb(1, 2, 3)",
    applicationModes: result.applications.map((application) =>
      application.development ? "development" : "production",
    ),
  };
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      if (server) {
        await server.stop();
        serverStopResolved = true;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
const cleanup = {
  consumerDirectoryRemoved: !existsSync(directory),
  browserDisconnected: browser !== undefined && !browser.isConnected(),
  serverStopResolved,
};
if (Object.values(cleanup).some((value) => !value))
  throw new Error("Consumer cleanup incomplete");
if (!evidence || !summary)
  throw new Error("Consumer evidence was not collected");
await mkdir(evidenceDirectory, { recursive: true });
await Bun.write(
  join(evidenceDirectory, "batch-i-package-consumer.json"),
  JSON.stringify({ ...evidence, cleanup }, null, 2) + "\n",
);
console.log(JSON.stringify({ ...summary, cleanup }));
