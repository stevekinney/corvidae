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

  const dev = await start("dev");
  if (dev.value.mode !== "development")
    throw new Error(`dev mode mismatch: ${dev.value.mode}`);
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
  dev.child.kill("SIGTERM");
  await dev.child.exited;
  observations.development = { mode: dev.value.mode, initial, afterClick };

  const built = run([process.execPath, "run", "build"], application);
  assertSuccess("generated application build", built);
  await rename(join(application, "src/routes"), join(directory, "routes"));
  const production = await start("start", { NODE_ENV: "production" });
  if (production.value.mode !== "production")
    throw new Error(`start mode mismatch: ${production.value.mode}`);
  const productionResponse = await fetch(production.value.url);
  if (productionResponse.status !== 200)
    throw new Error(`production HTTP status ${productionResponse.status}`);
  if (
    !(await productionResponse.text()).includes(
      "<title>Velveteen starter</title>",
    )
  )
    throw new Error("production SSR title missing");
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
