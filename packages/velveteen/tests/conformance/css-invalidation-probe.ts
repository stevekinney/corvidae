import { spawnWithHangGuard } from "@lostgradient/testing/hang-guard";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const root = resolve(import.meta.dir, "../..");
await mkdir(join(root, ".velveteen/probes"), { recursive: true });
const compiler = await Bun.file(join(root, "src/compiler/index.ts")).text();
const observations = [];
for (const sourceMaps of [true, false]) {
  const directory = await mkdtemp(join(root, ".velveteen/probes/css-"));
  const source = `<script lang="ts">let count: number = $state(0);</script>\n<button onclick={() => count++}>Original: {count}</button>\n<style>button { color: rgb(1, 2, 3); }</style>`;
  const compiledSource = sourceMaps
    ? compiler
    : compiler.replaceAll(
        "const sourceMap = result.map",
        "const sourceMap = !options.development && result.map",
      );
  if (!sourceMaps && compiledSource === compiler)
    throw new Error("source-map control did not alter the plugin");
  await Bun.write(join(directory, "compiler.ts"), compiledSource);
  await Bun.write(
    join(directory, "plugin.ts"),
    `import { createSveltePlugin } from './compiler.ts'; export default createSveltePlugin({development:true});`,
  );
  await Bun.write(
    join(directory, "bunfig.toml"),
    `[serve.static]\nplugins = ["./plugin.ts"]\n`,
  );
  await Bun.write(join(directory, "app.svelte"), source);
  await Bun.write(
    join(directory, "main.ts"),
    `import {mount} from 'svelte'; import App from './app.svelte'; mount(App,{target:document.querySelector('#app')!}); if(import.meta.hot) import.meta.hot.on('bun:afterUpdate',()=>document.documentElement.dataset.updated='yes');`,
  );
  await Bun.write(
    join(directory, "index.html"),
    `<!doctype html><html><head><title>CSS probe</title></head><body><div id="app"></div><script type="module" src="./main.ts"></script></body></html>`,
  );
  await Bun.write(
    join(directory, "server.ts"),
    `import page from './index.html'; const server=Bun.serve({hostname:'127.0.0.1',port:0,routes:{'/':page},development:{hmr:true}}); console.log(JSON.stringify({url:server.url.href})); process.once('SIGTERM',async()=>{await server.stop()});`,
  );
  const child = spawnWithHangGuard(
    [process.execPath, "--config=bunfig.toml", "server.ts"],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  const readiness = Promise.withResolvers<string>();
  let stdout = "";
  const output = (async () => {
    for await (const chunk of child.stdout) {
      stdout += new TextDecoder().decode(chunk);
      for (const line of stdout.split("\n"))
        if (line.startsWith('{"url"')) readiness.resolve(JSON.parse(line).url);
    }
  })();
  const errorsOutput = new Response(child.stderr).text();
  const browser = await chromium.launch();
  try {
    const url = await readiness.promise;
    const page = await browser.newPage();
    await page.goto(url);
    const button = page.getByRole("button");
    await expect(button).toHaveCSS("color", "rgb(1, 2, 3)");
    await button.click();
    await expect(button).toHaveText("Original: 1");
    await page.evaluate(() => {
      document.documentElement.dataset.identity = "original";
    });
    const edited = source.replace("rgb(1, 2, 3)", "rgb(4, 5, 6)");
    if (edited === source) throw new Error("CSS probe edit was a no-op");
    await Bun.write(join(directory, "app.svelte"), edited);
    await expect(button).toHaveCSS("color", "rgb(4, 5, 6)");
    await page.waitForFunction(
      () => document.documentElement.dataset.updated === "yes",
    );
    observations.push({
      sourceMaps,
      text: await button.textContent(),
      identity: await page.evaluate(
        () => document.documentElement.dataset.identity,
      ),
      color: await button.evaluate(
        (element) => getComputedStyle(element).color,
      ),
    });
  } finally {
    await browser.close();
    child.kill("SIGTERM");
    const exit = await child.exited;
    await output;
    const stderr = await errorsOutput;
    expect(exit, stderr).toBe(0);
    await rm(directory, { recursive: true, force: true });
  }
}
await mkdir(join(root, ".velveteen/evidence"), { recursive: true });
await Bun.write(
  join(root, ".velveteen/evidence/css-invalidation-control.json"),
  JSON.stringify({ bun: Bun.version, observations }, null, 2),
);
console.log(JSON.stringify(observations, null, 2));
