import { expect } from "@playwright/test";
import { join } from "node:path";
import { readVelveteenTestEnvironment } from "../environment-configuration.ts";
import type { RuntimeCase } from "./runtime-cases.ts";
import type { RuntimeBoundary } from "./runtime-fixture.ts";

export function remoteFixtures(
  root: string,
  boundary: RuntimeBoundary,
): Record<string, string> {
  if (boundary === "reference") {
    return {
      "src/routes/remote-v/data.remote.ts": `import {command,form,query} from "$app/server";
        import {error,invalid} from "@sveltejs/kit";
        const rows=new Map([["one","One"],["two","Two"]]);
        export const row=query.batch("unchecked",(keys)=>{
          if(new Set(keys).size!==keys.length)throw Error("Query inputs were not deduplicated");
          return key=>{const value=rows.get(key);if(value===undefined)error(404,"Not found");return value;};
        });
        export const change=command("unchecked",async key=>{rows.set(key,"Updated");await row(key).refresh();return true;});
        export const send=form("unchecked",(data,issue)=>{
          const message=String(data.message??"").trim();
          if(!message)invalid(issue.message("Enter a message"));
          return {message};
        });`,
      "src/routes/remote-v/+page.svelte": `<script lang="ts">
        import {onMount} from "svelte";
        import {row,change} from "./data.remote.ts";
        const keys=["one","two","one","missing"];
        const queries=keys.map(key=>row(key));
        let hydrated=$state(false);
        let rounds=$state(0);
        let reads=$state(0);
        let changed=$state(false);
        onMount(()=>{hydrated=true;});
        async function refresh(){await Promise.allSettled(queries.map(query=>query.refresh()));rounds++;}
        async function readCached(){await Promise.allSettled(queries.slice(0,3));reads++;}
        async function update(){await change("one");changed=true;}
      </script>
      <h1>Remote queries</h1>
      {#each queries as pending,index (index)}
        <svelte:boundary>
          <p data-remote-row={index}>{await pending}</p>
          {#snippet failed(failure)}
            <p data-remote-row={index}>{failure.message ?? failure.body?.message}</p>
          {/snippet}
        </svelte:boundary>
      {/each}
      <button disabled={!hydrated} onclick={refresh}>Refresh rows</button>
      <button disabled={!hydrated} onclick={readCached}>Read cached rows</button>
      <button disabled={!hydrated} onclick={update}>Change row</button>
      <p data-refresh-round>{rounds}</p><p data-cache-reads>{reads}</p><p data-command-complete>{changed}</p>`,
      "src/routes/remote-v/form/+page.svelte": `<script lang="ts">
        import {onMount} from "svelte";
        import {send} from "../data.remote.ts";
        let hydrated=$state(false);
        onMount(()=>{hydrated=true;});
      </script>
      <h1>Remote form</h1>
      <p data-form-hydrated>{hydrated}</p>
      <form {...send}><input aria-label="Message" {...send.fields.message.as("text")}><button>Send message</button></form>
      <p data-remote-form-result>{send.result?.message??""}</p>
      <p data-remote-form-issue>{send.fields.message.issues()?.[0]?.message??""}</p>`,
    };
  }

  const client = JSON.stringify(join(root, "src/remote/client.ts"));
  const definitions = JSON.stringify(
    join(root, "tests/conformance/runtime-remote-definitions.ts"),
  );
  const forms = JSON.stringify(join(root, "src/remote/forms.ts"));
  const navigation = JSON.stringify(
    join(root, "src/client/navigation-context.ts"),
  );
  const { remoteSplitBatches: split } = readVelveteenTestEnvironment();
  return {
    "src/routes/remote-v/+page.svelte": `<script lang="ts">
      import {onMount} from "svelte";
      import {createRemoteClient} from ${client};
      import type {runtimeRemoteDefinitions} from ${definitions};
      const keys=["one","two","one","missing"];
      let rows=$state<string[]>(keys.map(()=>""));
      let hydrated=$state(false);
      let rounds=$state(0);
      let reads=$state(0);
      let changed=$state(false);
      let refresh=$state<()=>void>(()=>{});
      let readCached=$state<()=>void>(()=>{});
      let update=$state<()=>void>(()=>{});
      onMount(()=>{
        const remote=createRemoteClient<typeof runtimeRemoteDefinitions>({baseURL:new URL("/runtime/",location.href),invalidate:()=>{}});
        const queries=keys.map(key=>remote.query("row",key));
        const unsubscribers=queries.map((query,index)=>query.subscribe(value=>{rows[index]=value;}));
        async function consume(work:Promise<string>[]){
          const results=await Promise.allSettled(work);
          for(const [index,result] of results.entries())rows[index]=result.status==="fulfilled"?result.value:result.reason.message;
        }
        refresh=async()=>{
          await consume(${split ? 'keys.map(key=>remote.call("row",key))' : "queries.map(query=>query.refresh())"});
          rounds++;
        };
        readCached=async()=>{await Promise.all(queries.slice(0,3).map(query=>query.get()));reads++;};
        update=async()=>{await remote.call("change","one");changed=true;};
        void consume(queries.map(query=>query.get())).then(()=>{hydrated=true;});
        return ()=>{for(const unsubscribe of unsubscribers)unsubscribe();};
      });
    </script>
    <h1>Remote queries</h1>
    {#each rows as value,index (index)}<p data-remote-row={index}>{value}</p>{/each}
    <button disabled={!hydrated} onclick={refresh}>Refresh rows</button>
    <button disabled={!hydrated} onclick={readCached}>Read cached rows</button>
    <button disabled={!hydrated} onclick={update}>Change row</button>
    <p data-refresh-round>{rounds}</p><p data-cache-reads>{reads}</p><p data-command-complete>{changed}</p>`,
    "src/routes/remote-v/form/+page.server.ts": `import {remoteFormAction} from ${forms}; export const load=({url})=>({action:remoteFormAction(url,"message")});`,
    "src/routes/remote-v/form/+page.svelte": `<script lang="ts">
      import {onMount} from "svelte";
      import {getNavigation} from ${navigation};
      let {data,form}=$props();
      const {enhance}=getNavigation();
      let hydrated=$state(false);
      onMount(()=>{hydrated=true;});
    </script>
    <h1>Remote form</h1>
    <p data-form-hydrated>{hydrated}</p>
    <form method="POST" action={data.action} use:enhance><input aria-label="Message" name="message"><button>Send message</button></form>
    <p data-remote-form-result>{form?.message??""}</p>
    <p data-remote-form-issue>{form?.issue??""}</p>`,
  };
}

export const runtimeRemoteQueries: RuntimeCase = {
  id: "V-query-batching",
  group: "actions",
  upstream:
    "packages/kit/test/apps/async/test/client.test.js: query.batch works; command does server-initiated single flight mutation (refresh)",
  expectedHttpErrors: [404],
  async run({ url, page, boundary }) {
    const network: string[] = [];
    const failedResponses: { status: number; path: string }[] = [];
    page.on("response", (response) => {
      if (response.status() >= 400)
        failedResponses.push({
          status: response.status(),
          path: new URL(response.url()).pathname,
        });
    });
    const prefix = boundary === "reference" ? "/_app/remote/" : "/_remote/";
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.includes(prefix))
        network.push(request.url());
    });
    await page.goto(new URL("/runtime/remote-v", url).href);
    for (const [index, text] of ["One", "Two", "One", "Not found"].entries())
      await expect(page.locator(`[data-remote-row="${index}"]`)).toHaveText(
        text,
      );
    await expect(
      page.getByRole("button", { name: "Refresh rows" }),
    ).toBeEnabled();

    network.length = 0;
    await page.getByRole("button", { name: "Read cached rows" }).click();
    await expect(page.locator("[data-cache-reads]")).toHaveText("1");
    expect(network, "V cached read requests").toHaveLength(0);

    await page.getByRole("button", { name: "Refresh rows" }).click();
    await expect(page.locator("[data-refresh-round]")).toHaveText("1");
    expect(network, "V batch wire requests").toHaveLength(1);
    await expect(page.locator('[data-remote-row="3"]')).toHaveText("Not found");

    network.length = 0;
    await page.getByRole("button", { name: "Change row" }).click();
    await expect(page.locator("[data-command-complete]")).toHaveText("true");
    await expect(page.locator('[data-remote-row="0"]')).toHaveText("Updated");
    await expect(page.locator('[data-remote-row="2"]')).toHaveText("Updated");
    await expect(page.locator('[data-remote-row="1"]')).toHaveText("Two");
    expect(
      network,
      "V command and refresh share one wire request",
    ).toHaveLength(1);
    expect(failedResponses).toEqual(
      boundary === "reference"
        ? [{ status: 404, path: "/runtime/remote-v" }]
        : [],
    );
  },
};

export const runtimeRemoteForms: RuntimeCase = {
  id: "V-progressive-forms",
  group: "actions",
  upstream: "packages/kit/test/apps/async/test/test.js: form works",
  async run({ url, page, browser }) {
    const address = new URL("/runtime/remote-v/form?existing=value", url).href;
    const native = await browser.newPage({ javaScriptEnabled: false });
    try {
      await native.goto(address);
      await native.getByLabel("Message").fill("Native message");
      const [posted] = await Promise.all([
        native.waitForRequest(
          (request) =>
            request.method() === "POST" && request.isNavigationRequest(),
        ),
        native.getByRole("button", { name: "Send message" }).click(),
      ]);
      expect(new URL(posted.url()).searchParams.get("existing")).toBe("value");
      expect(new URL(posted.url()).searchParams.has("/remote")).toBe(true);
      await expect(native.locator("[data-remote-form-result]")).toHaveText(
        "Native message",
      );
      expect(new URL(native.url()).searchParams.get("existing")).toBe("value");
    } finally {
      await native.close();
    }

    await page.goto(address);
    await expect(page.locator("[data-form-hydrated]")).toHaveText("true");
    const marker = await page.evaluate(() => {
      const marker = crypto.randomUUID();
      Reflect.set(window, "remoteFormDocument", marker);
      return marker;
    });
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator("[data-remote-form-issue]")).toHaveText(
      "Enter a message",
    );
    await page.getByLabel("Message").fill("Enhanced message");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator("[data-remote-form-result]")).toHaveText(
      "Enhanced message",
    );
    expect(new URL(page.url()).searchParams.get("existing")).toBe("value");
    expect(
      await page.evaluate(() => Reflect.get(window, "remoteFormDocument")),
    ).toBe(marker);
  },
};
