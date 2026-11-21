import { expect } from "@playwright/test";
import { resolve } from "node:path";
import { readVelveteenTestEnvironment } from "../environment-configuration.ts";
import type { RuntimeBoundary } from "./runtime-fixture.ts";
import type { RuntimeCase } from "./runtime-cases.ts";

const path = (url: string, route: string) =>
  new URL(`/runtime${route}`, url).href;

/** Fixtures for custom transport page data and the shared transport type. */
export function customTransportFixtures(
  boundary: RuntimeBoundary,
): Record<string, string> {
  const extension = boundary === "reference" ? "js" : "ts";
  const field = boundary === "reference" ? "#value" : "#value: string";
  const argument = boundary === "reference" ? "value" : "value: string";
  const plainSnapshot =
    boundary === "candidate" &&
    readVelveteenTestEnvironment().transportPlainObject;
  const plainAction =
    boundary === "candidate" &&
    readVelveteenTestEnvironment().actionTransportPlainObject;
  const transport =
    boundary === "reference"
      ? `import { TransportValue } from './lib/transport-value.js'; export const transport={TransportValue:{encode:(value)=>value instanceof TransportValue?[value.value]:false,decode:([value])=>new TransportValue(value)}};`
      : `import { TransportValue } from './lib/transport-value.ts'; export const transport={TransportValue:{encode:(value: unknown)=>value instanceof TransportValue?[value.value]:false,decode:([value]: [string])=>${plainSnapshot ? "value==='saved'?{value}:" : ""}${plainAction ? "value==='Action U-Enhanced'?{value}:" : ""}new TransportValue(value)}};`;
  return {
    [`src/lib/transport-value.${extension}`]: `export class TransportValue { ${field}; constructor(${argument}) { this.#value = value; } describe() { return \`transport value: \${this.#value}\`; } get value() { return this.#value; } }`,
    [boundary === "reference" ? "src/hooks.js" : "src/transport.ts"]: transport,
    "src/routes/transport-q/+page.server.ts": `import { TransportValue } from '../../lib/transport-value.${extension}'; export const load=()=>({value:new TransportValue('initial')});`,
    "src/routes/transport-q/+page.svelte": `<script lang="ts">import { onMount } from 'svelte'; let {data}=$props(); let hydrated=$state(false); let interaction=$state(''); onMount(()=>hydrated=true);</script><main data-transport-page><h1>Custom transport</h1><p data-transport-hydrated>{hydrated ? 'true' : 'false'}</p><p data-transport-initial>{data.value.value}</p><p data-transport-ssr-method>{data.value.describe()}</p><button onclick={()=>interaction=data.value.describe()}>Use transport method</button><p data-transport-interaction>{interaction}</p><a href="/runtime/transport-q/next">Next</a></main>`,
    "src/routes/transport-q/next/+page.server.ts": `import { deferred } from '../../../lib/state.server.ts'; import { TransportValue } from '../../../lib/transport-value.${extension}'; export const load=()=>{const work=Promise.withResolvers<string>(); deferred.set('q-transport-next',work); return {value:new TransportValue('navigation'), settled:work.promise.then(()=>new TransportValue('settled'))};};`,
    "src/routes/transport-q/next/+page.svelte": `<script lang="ts">let {data}=$props(); let interaction=$state('');</script><main data-transport-next><h1>Custom transport next</h1><p data-transport-navigation>{data.value.value}</p><button onclick={()=>interaction=data.value.describe()}>Use navigation method</button><p data-transport-navigation-method>{interaction}</p>{#await data.settled}<p data-transport-navigation-pending>pending</p>{:then value}<p data-transport-navigation-settled>{value.describe()}</p>{/await}<a href="/runtime/transport-q">Back</a></main>`,
  };
}

/** Snapshot-only routes; callers must gate harness registration on Q01. */
export function transportSnapshotFixtures(
  boundary: RuntimeBoundary,
): Record<string, string> {
  const extension = boundary === "reference" ? "js" : "ts";
  const navigation =
    boundary === "reference"
      ? `import { onMount } from 'svelte'; import { afterNavigate, snapshot } from '$app/navigation';`
      : `import { onMount } from 'svelte'; import {afterNavigate,snapshot} from ${JSON.stringify(resolve(import.meta.dir, "../../src/client/navigation-context.ts"))};`;
  return {
    "src/routes/transport-q/snapshot/+page.svelte": `<script lang="ts">
      ${navigation}
      import { TransportValue } from '../../../lib/transport-value.${extension}';
      let value = $state.raw(new TransportValue('initial'));
      let order = $state<string[]>([]);
      let hydrated = $state(false);
      let interaction = $state('');
      snapshot({id:'q-transport-snapshot',capture:()=>value,restore:(restored)=>{value=restored;order.push('restore');}});
      afterNavigate(() => { order.push('afterNavigate'); });
      onMount(() => { hydrated = true; });
    </script>
    <main data-transport-snapshot>
      <h1>Transport snapshot</h1>
      <p data-transport-snapshot-ready>{hydrated ? 'true' : 'false'}</p>
      <p data-transport-snapshot-value>{value.value}</p>
      <p data-transport-snapshot-instance>{String(value instanceof TransportValue)}</p>
      <p data-transport-snapshot-order>{order.join(',')}</p>
      <button onclick={() => value = new TransportValue('saved')}>Save value</button>
      <button onclick={() => interaction = value.describe()}>Read restored value</button>
      <p data-transport-snapshot-method>{interaction}</p>
    </main>`,
  };
}

export const runtimeCustomTransport: RuntimeCase = {
  id: "Q-custom-transport",
  group: "navigation",
  upstream:
    "packages/kit/test/apps/basics/test/playwright/test.js: A custom data type can be serialized/deserialized; works with streaming",
  async run({ url, page }) {
    const response = await fetch(path(url, "/transport-q"));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h1>Custom transport</h1>");
    expect(html).toContain("transport value: initial");
    let documentRequests = 0;
    page.on("request", (request) => {
      if (request.resourceType() === "document") documentRequests++;
    });
    const hydration = Promise.withResolvers<void>();
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() === "script") await hydration.promise;
      await route.continue();
    });
    try {
      await page.goto(path(url, "/transport-q"), { waitUntil: "commit" });
      await expect(page.locator("[data-transport-hydrated]")).toHaveText(
        "false",
      );
      await page.evaluate(() =>
        Reflect.set(
          window,
          "qServerTransportNode",
          document.querySelector("[data-transport-page]"),
        ),
      );
    } finally {
      hydration.resolve();
    }
    await expect(page.locator("[data-transport-hydrated]")).toHaveText("true");
    expect(
      await page.evaluate(
        () =>
          Reflect.get(window, "qServerTransportNode") ===
          document.querySelector("[data-transport-page]"),
      ),
      "Q hydration retains server-rendered DOM",
    ).toBe(true);
    await expect(page.locator("[data-transport-initial]")).toHaveText(
      "initial",
    );
    await expect(page.locator("[data-transport-ssr-method]")).toHaveText(
      "transport value: initial",
    );
    await page.getByRole("button", { name: "Use transport method" }).click();
    await expect(page.locator("[data-transport-interaction]")).toHaveText(
      "transport value: initial",
    );
    await page.getByRole("link", { name: "Next" }).click();
    await expect(
      page.getByRole("heading", { name: "Custom transport next" }),
    ).toBeVisible();
    await expect(page.locator("[data-transport-navigation]")).toHaveText(
      "navigation",
    );
    await page.getByRole("button", { name: "Use navigation method" }).click();
    await expect(page.locator("[data-transport-navigation-method]")).toHaveText(
      "transport value: navigation",
    );
    await expect(
      page.locator("[data-transport-navigation-pending]"),
    ).toHaveText("pending");
    expect(
      await page.evaluate(
        async (release) => {
          const response = await fetch(release, { method: "POST" });
          return response.status;
        },
        path(url, "/release?key=q-transport-next"),
      ),
    ).toBe(200);
    await expect(
      page.locator("[data-transport-navigation-settled]"),
    ).toHaveText("transport value: settled");
    expect(documentRequests).toBe(1);
  },
};

export const runtimeTransportSnapshots: RuntimeCase = {
  id: "Q-transport-snapshots",
  group: "navigation",
  upstream:
    "packages/kit/test/apps/basics/test/playwright/client.test.js: persists function snapshots with transport support",
  async run({ url, page }) {
    await page.goto(path(url, "/transport-q/snapshot"));
    await expect(page.locator("[data-transport-snapshot-value]")).toHaveText(
      "initial",
    );
    await expect(
      page.locator("[data-transport-snapshot-instance]"),
      "Q initial snapshot instance",
    ).toHaveText("true");
    await expect(page.locator("[data-transport-snapshot-ready]")).toHaveText(
      "true",
    );
    await page.getByRole("button", { name: "Save value" }).click();
    await expect(page.locator("[data-transport-snapshot-value]")).toHaveText(
      "saved",
    );
    await page.reload();
    await expect(page.locator("[data-transport-snapshot-value]")).toHaveText(
      "saved",
    );
    await expect(page.locator("[data-transport-snapshot-order]")).toHaveText(
      "afterNavigate,restore",
    );
    await expect(
      page.locator("[data-transport-snapshot-instance]"),
      "Q restored snapshot instance",
    ).toHaveText("true");
    await page.getByRole("button", { name: "Read restored value" }).click();
    await expect(page.locator("[data-transport-snapshot-method]")).toHaveText(
      "transport value: saved",
    );
  },
};
