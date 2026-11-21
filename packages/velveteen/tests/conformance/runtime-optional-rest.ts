import { expect, type Page } from "@playwright/test";
import { readVelveteenTestEnvironment } from "../environment-configuration.ts";

export function optionalRestFixtures(
  boundary: "candidate" | "reference",
): Record<string, string> {
  const corrupt =
    boundary === "candidate" &&
    readVelveteenTestEnvironment().optionalRestCorrupt;
  return {
    "src/routes/docs/[[section=section]]/[...path=docPath]/+page.server.ts": `export const load=({params})=>{const value={...params};${corrupt ? "if(value.path==='guide/install')value.path=value.path.split('/').slice(1).join('/');" : ""}return {label:'optional-rest',params:JSON.stringify(value),hasSection:Object.hasOwn(value,'section'),hasPath:Object.hasOwn(value,'path'),runs:globalThis.__optionalRestRuns=(globalThis.__optionalRestRuns??0)+1};};`,
    "src/routes/docs/[[section=section]]/[...path=docPath]/+page.ts":
      "export const load=({data,params})=>({...data,clientParams:JSON.stringify(params)});",
    "src/routes/docs/[[section=section]]/[...path=docPath]/+page.svelte":
      '<script lang="ts">let {data}=$props();</script><h1>{data.label}</h1><p data-params>{data.params}</p><p data-client-params>{data.clientParams}</p><p data-section-own>{String(data.hasSection)}</p><p data-path-own>{String(data.hasPath)}</p><p data-runs>{data.runs}</p>',
    "src/routes/docs-reject/qualified/[...path=nonEmpty]/+page.svelte":
      "<h1>qualified</h1>",
    "src/routes/docs-reject/[...path]/+page.svelte":
      "<h1 data-fallback>fallback</h1>",
  };
}

export async function runOptionalRestCase({
  url,
  page,
}: {
  url: string;
  page: Page;
}) {
  const route = (value: string) => new URL(`/runtime${value}`, url).href;
  const expected = async (value: string, text: string) => {
    const response = await fetch(route(value));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(text);
  };

  await expected("/docs/42/guide", '"section":42,"path":"guide"');
  await expected("/docs/guide/install", '"path":"guide/install"');
  await expected("/docs", '"path":""');
  const missing = await fetch(route("/docs"));
  const missingHtml = await missing.text();
  expect(missingHtml).toContain('data-section-own="">false');
  expect(missingHtml).toContain('data-path-own="">true');
  const rejected = await fetch(route("/docs-reject/qualified"));
  expect(rejected.status).toBe(200);
  expect(await rejected.text()).toContain("fallback");
  const qualified = await fetch(route("/docs-reject/qualified/guide"));
  expect(qualified.status).toBe(200);
  expect(await qualified.text()).toContain("qualified");

  let documentRequests = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") documentRequests++;
  });
  await page.goto(route("/docs/42/guide"));
  await expect(page.locator("[data-params]")).toHaveText(
    '{"section":42,"path":"guide"}',
  );
  await expect(page.locator("[data-client-params]")).toHaveText(
    '{"section":42,"path":"guide"}',
  );
  await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
  const before = Number(await page.locator("[data-runs]").textContent());
  await page.evaluate(() =>
    Reflect.get(window, "runtime").goto("/runtime/docs/guide/install"),
  );
  await expect(page.locator("[data-params]")).toHaveText(
    '{"path":"guide/install"}',
  );
  await expect(page.locator("[data-client-params]")).toHaveText(
    '{"path":"guide/install"}',
  );
  await expect(page.locator("[data-runs]")).not.toHaveText(String(before));
  expect(documentRequests).toBe(1);
  await page.evaluate(() =>
    Reflect.get(window, "runtime").goto("/runtime/docs/42/a%2Fb"),
  );
  await expect(page.locator("[data-params]")).toHaveText(
    '{"section":42,"path":"a/b"}',
  );
  await page.evaluate(() =>
    Reflect.get(window, "runtime").goto("/runtime/docs/42/%252F"),
  );
  await expect(page.locator("[data-params]")).toHaveText(
    '{"section":42,"path":"%2F"}',
  );
  await page.evaluate(() =>
    Reflect.get(window, "runtime").goto("/runtime/docs"),
  );
  await expect(page.locator("[data-section-own]")).toHaveText("false");
  await expect(page.locator("[data-path-own]")).toHaveText("true");
  expect(documentRequests).toBe(1);
}
