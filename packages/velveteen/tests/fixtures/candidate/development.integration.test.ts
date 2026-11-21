import { spawnWithHangGuard } from "@lostgradient/testing/hang-guard";
import { afterAll, expect, test } from "bun:test";
import { chromium, expect as browserExpect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

type Readiness = {
  kind: "ready";
  mode: string;
  url: string;
  pid: number;
  bun: string;
};
type Candidate = {
  child: ReturnType<typeof Bun.spawn>;
  page: Page;
  sourceDirectory: string;
  readiness: Readiness;
  stop: () => Promise<void>;
};
const fixtureDirectory = import.meta.dir;
const projectRoot = resolve(fixtureDirectory, "../../..");
const sourceFiles = [
  "main.ts",
  "index.html",
  "app.svelte",
  "counter.svelte.ts",
];

const createSourceDirectory = async () => {
  const sourceDirectory = await mkdtemp(
    join(projectRoot, ".velveteen/candidate-development-"),
  );
  await Promise.all(
    sourceFiles.map(async (file) =>
      Bun.write(
        join(sourceDirectory, file),
        await Bun.file(join(fixtureDirectory, file)).arrayBuffer(),
      ),
    ),
  );
  return sourceDirectory;
};

const launchCandidate = async (): Promise<Candidate> => {
  const sourceDirectory = await createSourceDirectory();
  const child = spawnWithHangGuard(
    [
      process.execPath,
      "--config=bunfig.toml",
      "server.ts",
      "--mode",
      "development",
      "--source-directory",
      sourceDirectory,
    ],
    { cwd: fixtureDirectory, stdout: "pipe", stderr: "pipe" },
  );
  const output: string[] = [];
  let resolveReady!: (readiness: Readiness) => void;
  const ready = new Promise<Readiness>((resolve) => {
    resolveReady = resolve;
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        output.push(line);
        try {
          const parsed = JSON.parse(line) as Readiness;
          if (parsed.kind === "ready") resolveReady(parsed);
        } catch {
          // Preserve non-JSON diagnostics in output for failed child cleanup.
        }
      }
    }
  };
  const stdoutDone = drain(child.stdout);
  const stderrDone = drain(child.stderr);
  let readiness: Readiness;
  try {
    readiness = await Promise.race([
      ready,
      child.exited.then(() => {
        throw new Error(
          `candidate exited before readiness: ${output.join("\n")}`,
        );
      }),
    ]);
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    await Promise.all([stdoutDone, stderrDone]);
    await rm(sourceDirectory, { recursive: true, force: true });
    throw error;
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch();
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    await Promise.all([stdoutDone, stderrDone]);
    await rm(sourceDirectory, { recursive: true, force: true });
    throw error;
  }
  const page = await browser.newPage();
  const stop = async () => {
    await page.close();
    await browser.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    const exitCode = await child.exited;
    await Promise.all([stdoutDone, stderrDone]);
    if (exitCode !== 0)
      throw new Error(`candidate exited ${exitCode}: ${output.join("\n")}`);
    await rm(sourceDirectory, { recursive: true, force: true });
  };
  return { child, page, sourceDirectory, readiness, stop };
};

const noBrowserErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      errors.push(message.text());
  });
  return errors;
};

const pending = new Set<Candidate>();
async function prepareCandidate() {
  try {
    const candidate = await launchCandidate();
    pending.add(candidate);
    return candidate;
  } catch (error) {
    await Promise.allSettled(
      Array.from(pending, (candidate) => candidate.stop()),
    );
    throw error;
  }
}
const cssCandidate = await prepareCandidate();
const hotCandidate = await prepareCandidate();
const recoveryCandidate = await prepareCandidate();
afterAll(async () => {
  await Promise.all(Array.from(pending, (candidate) => candidate.stop()));
});

test("P05: CSS edits preserve state and document identity", async () => {
  const candidate = cssCandidate;
  const errors = noBrowserErrors(candidate.page);
  try {
    await candidate.page.goto(`${candidate.readiness.url}proof`);
    const button = candidate.page.locator("#app button");
    await browserExpect(button).toHaveText("Original: 0");
    await browserExpect(button).toHaveCSS("color", "rgb(1, 2, 3)");
    await button.click();
    await browserExpect(button).toHaveText("Original: 1");
    await candidate.page.evaluate(() => {
      document.documentElement.dataset.probeDocument = "same-document";
    });
    const appPath = join(candidate.sourceDirectory, "app.svelte");
    const source = await Bun.file(appPath).text();
    await Bun.write(appPath, source.replace("rgb(1, 2, 3)", "rgb(4, 5, 6)"));
    await browserExpect(button).toHaveCSS("color", "rgb(4, 5, 6)");
    await browserExpect(button).toHaveText("Original: 1");
    expect(
      await candidate.page.evaluate(
        () => document.documentElement.dataset.probeDocument,
      ),
    ).toBe("same-document");
    expect(errors).toEqual([]);
  } finally {
    pending.delete(candidate);
    await candidate.stop();
  }
});

test("P06: component and rune edits update the mounted document", async () => {
  const candidate = hotCandidate;
  const errors = noBrowserErrors(candidate.page);
  try {
    await candidate.page.goto(`${candidate.readiness.url}proof`);
    const button = candidate.page.locator("#app button");
    await browserExpect(button).toHaveText("Original: 0");
    await candidate.page.evaluate(() => {
      document.documentElement.dataset.probeDocument = "same-document";
    });
    const appPath = join(candidate.sourceDirectory, "app.svelte");
    const counterPath = join(candidate.sourceDirectory, "counter.svelte.ts");
    await Bun.write(
      appPath,
      (await Bun.file(appPath).text()).replace(
        "Original: {counter.value}",
        "Updated: {counter.value}",
      ),
    );
    await browserExpect(button).toHaveText("Updated: 0");
    await button.click();
    await browserExpect(button).toHaveText("Updated: 1");
    await Bun.write(
      counterPath,
      (await Bun.file(counterPath).text()).replace("value += 1", "value += 2"),
    );
    await browserExpect(button).toHaveText("Updated: 0");
    await button.click();
    await browserExpect(button).toHaveText("Updated: 2");
    expect(
      await candidate.page.evaluate(
        () => document.documentElement.dataset.probeDocument,
      ),
    ).toBe("same-document");
    expect(errors).toEqual([]);
  } finally {
    pending.delete(candidate);
    await candidate.stop();
  }
});

test("P07: malformed source reports diagnostics and repairs in place", async () => {
  const candidate = recoveryCandidate;
  const errors = noBrowserErrors(candidate.page);
  try {
    await candidate.page.goto(`${candidate.readiness.url}proof`);
    const button = candidate.page.locator("#app button");
    await browserExpect(button).toHaveText("Original: 0");
    await candidate.page.evaluate(() => {
      document.documentElement.dataset.probeDocument = "same-document";
    });
    const appPath = join(candidate.sourceDirectory, "app.svelte");
    const original = await Bun.file(appPath).text();
    await Bun.write(
      appPath,
      original.replace('<script lang="ts">', '<script lang="ts">\nlet = ;'),
    );
    await candidate.page.waitForFunction(async (filename) => {
      const diagnostics = (await fetch("/__diagnostics").then((response) =>
        response.json(),
      )) as Array<{
        filename: string;
        message: string;
        line: number;
        column: number;
      }>;
      return diagnostics.some(
        (diagnostic) =>
          diagnostic.filename.endsWith(filename) &&
          diagnostic.line >= 2 &&
          diagnostic.message.length > 0,
      );
    }, "app.svelte");
    await browserExpect(button).toHaveText("Original: 0");
    await Bun.write(
      appPath,
      original.replace(
        "Original: {counter.value}",
        "Repaired: {counter.value}",
      ),
    );
    await browserExpect(button).toHaveText("Repaired: 0");
    expect(
      await candidate.page.evaluate(
        () => document.documentElement.dataset.probeDocument,
      ),
    ).toBe("same-document");
    expect(errors).toEqual([]);
  } finally {
    pending.delete(candidate);
    await candidate.stop();
  }
});
