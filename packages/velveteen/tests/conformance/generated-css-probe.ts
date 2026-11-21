import { spawnWithHangGuard } from "@lostgradient/testing/hang-guard";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compile } from "svelte/compiler";
import { chromium, expect } from "@playwright/test";

const root = resolve(import.meta.dir, "../..");
await mkdir(join(root, ".velveteen/probes"), { recursive: true });
const directory = await mkdtemp(join(root, ".velveteen/probes/generated-css-"));
const sourcePath = join(directory, "source.svelte");
const source = `<script lang="ts">let count: number = $state(0);</script>\n<button onclick={() => count++}>Original: {count}</button>\n<style>button { color: rgb(1, 2, 3); }</style>`;
let previousJavascript = "";
async function compileSource(source: string) {
  await Bun.write(sourcePath, source);
  const compiled = compile(source, {
    filename: sourcePath,
    generate: "client",
    css: "external",
    cssHash: () => "stable-probe-style",
    dev: true,
    hmr: true,
  });
  const javascript = `${compiled.js.code}\nimport './component.css';\n//# sourceMappingURL=component.ts.map\n`;
  await Bun.write(
    join(directory, "component.ts.map"),
    JSON.stringify(compiled.js.map),
  );
  await Bun.write(join(directory, "component.css"), compiled.css!.code);
  const javascriptChanged = javascript !== previousJavascript;
  if (javascriptChanged)
    await Bun.write(join(directory, "component.ts"), javascript);
  previousJavascript = javascript;
  return javascriptChanged;
}
await compileSource(source);
await Bun.write(
  join(directory, "main.ts"),
  `import {mount} from 'svelte'; import App from './component.ts'; mount(App,{target:document.querySelector('#app')!});`,
);
await Bun.write(
  join(directory, "index.html"),
  `<!doctype html><html><head><title>Generated CSS probe</title></head><body><div id="app"></div><script type="module" src="./main.ts"></script></body></html>`,
);
await Bun.write(
  join(directory, "server.ts"),
  `import page from './index.html'; const server=Bun.serve({hostname:'127.0.0.1',port:0,routes:{'/':page},development:{hmr:true}}); console.log(JSON.stringify({url:server.url.href})); process.once('SIGTERM',async()=>{await server.stop()});`,
);
const child = spawnWithHangGuard([process.execPath, "server.ts"], {
  cwd: directory,
  stdout: "pipe",
  stderr: "pipe",
});
const ready = Promise.withResolvers<string>();
let stdout = "";
const output = (async () => {
  for await (const chunk of child.stdout) {
    stdout += new TextDecoder().decode(chunk);
    for (const line of stdout.split("\n"))
      if (line.startsWith('{"url"')) ready.resolve(JSON.parse(line).url);
  }
})();
const errorsOutput = new Response(child.stderr).text();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(await ready.promise);
  const button = page.getByRole("button");
  await expect(button).toHaveCSS("color", "rgb(1, 2, 3)");
  await button.click();
  await expect(button).toHaveText("Original: 1");
  await page.evaluate(() => {
    document.documentElement.dataset.identity = "original";
  });
  const javascriptChanged = await compileSource(
    source.replace("rgb(1, 2, 3)", "rgb(4, 5, 6)"),
  );
  await expect(button).toHaveCSS("color", "rgb(4, 5, 6)");
  const observation = {
    javascriptChanged,
    text: await button.textContent(),
    identity: await page.evaluate(
      () => document.documentElement.dataset.identity,
    ),
    color: await button.evaluate((element) => getComputedStyle(element).color),
  };
  await Bun.write(
    join(root, ".velveteen/evidence/generated-css-control.json"),
    JSON.stringify({ bun: Bun.version, observation }, null, 2),
  );
  console.log(JSON.stringify(observation));
} finally {
  await browser.close();
  child.kill("SIGTERM");
  const exit = await child.exited;
  await output;
  expect(exit, await errorsOutput).toBe(0);
  await errorsOutput;
  await rm(directory, { recursive: true, force: true });
}
