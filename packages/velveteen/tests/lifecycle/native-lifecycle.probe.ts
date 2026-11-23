import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import {
  afterAwakeTime,
  HANG_GUARD_MILLISECONDS,
  spawnWithHangGuard,
} from "@lostgradient/testing/hang-guard";
import { awakeTurns } from "@lostgradient/testing/wait-until";
import { expect } from "bun:test";
import { compile } from "svelte/compiler";
import { chromium } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const hotEvidencePath = join(
  import.meta.dir,
  "../../.velveteen/evidence/p10-native-hot-lifecycle.json",
);
const graphEvidencePath = join(
  import.meta.dir,
  "../../.velveteen/evidence/p10-module-graph.json",
);

const waitFor = async <T>(
  label: string,
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
) => {
  for await (const _ of awakeTurns({ message: label })) {
    const value = await read();
    if (predicate(value)) return value;
  }
  throw new Error(`P10 native lifecycle condition did not settle: ${label}`);
};

const startFixture = async (directory: string) => {
  const child = spawnWithHangGuard(
    [process.execPath, "--hot", join(directory, "server.ts")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const next = await reader.read();
    if (next.done) throw new Error(`--hot exited before readiness: ${output}`);
    output += new TextDecoder().decode(next.value);
  }
  return { child, ready: JSON.parse(output.trim()) as { url: string } };
};

async function probeNativeHot() {
  const directory = await mkdtemp(join(probeRoot, "fixture-"));
  await mkdir(join(directory, "components"));
  const component = compile(
    `<script>import { value } from "../value.ts";</script><p id="proof">Original: {value}</p>`,
    { filename: "Proof.svelte", generate: "server" },
  ).js.code;
  await Bun.write(join(directory, "value.ts"), `export const value = "A";\n`);
  await Bun.write(join(directory, "components/Proof.js"), component);
  await Bun.write(
    join(directory, "server.ts"),
    `import { render } from "svelte/server"; import Proof from "./components/Proof.js"; import { value } from "./value.ts";
const pending = new Map<string, (response: Response) => void>(); let admitted = false; let heldValue = "";
const callbacks = globalThis.__p10_callbacks ??= []; const resources = globalThis.__p10_resources ??= { active: 0 };
resources.active += 1; const generation = value; const callback = () => callbacks.push(generation); globalThis.__p10_events ??= new EventTarget(); globalThis.__p10_events.addEventListener("tick", callback);
const html = () => render(Proof).body;
const server = Bun.serve({ port: 0, fetch(request) { const path = new URL(request.url).pathname; if (path === "/proof") return new Response(html(), { headers: { "content-type": "text/html" } }); if (path === "/endpoint") return Response.json({ status: "ok" }); if (path === "/hold") { admitted = true; heldValue = value; return new Promise(resolve => pending.set("hold", resolve)); } if (path === "/release") { pending.get("hold")?.(new Response(heldValue)); return new Response("released"); } if (path === "/tick") { globalThis.__p10_events.dispatchEvent(new Event("tick")); return Response.json({ callbacks }); } if (path === "/state") return Response.json({ callbacks, resources: resources.active, admitted }); return new Response("not found", { status: 404 }); } });
console.log(JSON.stringify({ url: server.url.href }));
`,
  );
  const { child, ready } = await startFixture(directory);
  const held = fetch(new URL("/hold", ready.url));
  await waitFor(
    "hold admission",
    async () => (await fetch(new URL("/state", ready.url))).json(),
    (state) => (state as { admitted: boolean }).admitted,
  );
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      browserErrors.push(message.text());
  });
  try {
    expect(await (await fetch(new URL("/proof", ready.url))).text()).toContain(
      "Original: A",
    );
    await page.goto(new URL("/proof", ready.url).href);
    await Bun.write(join(directory, "value.ts"), `export const value = "B";\n`);
    await waitFor(
      "B",
      async () => (await fetch(new URL("/proof", ready.url))).text(),
      (html) => html.includes("Original: B"),
    );
    expect(
      await page.evaluate(async () =>
        fetch("/proof").then((response) => response.text()),
      ),
    ).toContain("Original: B");
    expect(await (await fetch(new URL("/release", ready.url))).text()).toBe(
      "released",
    );
    const settled = Promise.withResolvers<string>();
    const cancelDeadline = afterAwakeTime(HANG_GUARD_MILLISECONDS, () => {
      settled.resolve("UNSETTLED");
    });
    void held
      .then((response) => response.text())
      .then(settled.resolve, () => {
        settled.resolve("UNSETTLED");
      });
    const heldText = await settled.promise.finally(cancelDeadline);
    expect(browserErrors).toEqual([]);
    const callbackFailures: string[] = [];
    let callbackCount = 0;
    for (let index = 0; index < 10; index += 1) {
      await Bun.write(
        join(directory, "value.ts"),
        `export const value = "E${index}";\n`,
      );
      await waitFor(
        `E${index}`,
        async () => (await fetch(new URL("/proof", ready.url))).text(),
        (html) => html.includes(`Original: E${index}`),
      );
      const state = (await (
        await fetch(new URL("/tick", ready.url))
      ).json()) as { callbacks: string[] };
      expect(state.callbacks.at(-1)).toBe(`E${index}`);
      const delta = state.callbacks.slice(callbackCount);
      callbackCount = state.callbacks.length;
      if (JSON.stringify(delta) !== JSON.stringify([`E${index}`]))
        callbackFailures.push(`E${index}: ${delta.join(",")}`);
    }
    await Bun.write(
      hotEvidencePath,
      JSON.stringify(
        {
          probe: "P10-native-hot-lifecycle",
          bun: Bun.version,
          heldRequest: heldText,
          failedCriterion: [
            ...(heldText === "A"
              ? []
              : [
                  "native --hot did not complete the admitted A request after publication",
                ]),
            ...(callbackFailures.length === 0
              ? []
              : ["retired --hot generations retained event callbacks"]),
          ],
          freshDocument: "B",
          browserFetch: "B",
          callbacks:
            callbackFailures.length === 0
              ? "one-current-zero-retired"
              : callbackFailures,
          browserErrors,
          source: "Svelte SSR compile + transitive value module",
          status:
            heldText === "A" && callbackFailures.length === 0
              ? "pass"
              : "unsupported-native-contract",
          limitation:
            "ModuleGraph disposal remains separately documented; --hot does not expose graph disposal to the fixture",
        },
        null,
        2,
      ) + "\n",
    );
    if (heldText !== "A" || callbackFailures.length > 0)
      throw new Error(
        `P10 criterion failed: ${heldText !== "A" ? "native --hot did not complete the admitted A request after publication" : "retired --hot generations retained event callbacks"}`,
      );
  } finally {
    await browser.close();
    child.kill(9);
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}

async function probeModuleGraph() {
  expect(typeof Bun.ModuleGraph).toBe("function");
  const directory = await mkdtemp(join(probeRoot, "graph-"));
  await Bun.write(join(directory, "value.ts"), `export const value = "A";\n`);
  await Bun.write(
    join(directory, "entry.ts"),
    `import { value } from "./value.ts"; export const current = value;\n`,
  );
  await Bun.write(
    join(directory, "resource.ts"),
    `export const server = Bun.serve({ port: 0, fetch: () => new Response("graph") });\n`,
  );
  const first = new Bun.ModuleGraph();
  const firstEntry = await first.import<{ current: string }>(
    join(directory, "entry.ts"),
  );
  await Bun.write(join(directory, "value.ts"), `export const value = "B";\n`);
  const second = new Bun.ModuleGraph();
  const secondEntry = await second.import<{ current: string }>(
    join(directory, "entry.ts"),
  );
  expect(firstEntry.current).toBe("A");
  expect(secondEntry.current).toBe("B");
  const resourceGraph = new Bun.ModuleGraph();
  const resource = await resourceGraph.import<{
    server: Bun.Server<undefined>;
  }>(join(directory, "resource.ts"));
  expect(await (await fetch(resource.server.url)).text()).toBe("graph");
  resourceGraph.dispose();
  expect(await throwingRejectionOf(fetch(resource.server.url))).toThrow();
  first.dispose();
  second.dispose();
  await rm(directory, { recursive: true, force: true });
  await Bun.write(
    graphEvidencePath,
    JSON.stringify(
      {
        moduleGraph: "isolated-transitive-state-and-owned-server-disposal",
        first: "A",
        second: "B",
        disposedFetch: "rejected",
        docsLimit:
          "host-global listeners and pending graph promises require explicit application cleanup before dispose",
      },
      null,
      2,
    ) + "\n",
  );
}

const probeRoot = join(import.meta.dir, "../../.velveteen/lifecycle");
await mkdir(probeRoot, { recursive: true });
await probeModuleGraph();
await probeNativeHot();
