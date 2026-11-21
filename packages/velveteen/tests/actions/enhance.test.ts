import { expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
type Control = {
  calls: { url: string; method: string; body: string; signal: AbortSignal }[];
  settle: (index: number, success: boolean) => void;
  dispose: () => void;
  errors: string[];
};
test("G03: enhanced forms respect submitters and clobbered DOM names; stale/disposed completions cannot reset fields", async () => {
  const parent = resolve(".velveteen/actions");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "enhance-"));
  const browser = await chromium.launch();
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const entry = join(root, "browser.ts");
    await Bun.write(
      entry,
      `import {enhance} from ${JSON.stringify(resolve("src/actions/enhance.ts"))};const calls=[],resolvers=[],errors=[];const dispose=enhance(document.querySelector('form'),{submit:(url,init)=>{calls.push({url:url.href,method:init.method,body:String(init.body),signal:init.signal});return new Promise(resolve=>resolvers.push(resolve));},onError:error=>errors.push(String(error))});window.control={calls,errors,dispose,settle:(index,success)=>resolvers[index]({type:success?'success':'failure',status:success?200:422,data:{}})};`,
    );
    const built = await Bun.build({ entrypoints: [entry], target: "browser" });
    if (!built.success || built.logs.length)
      throw new AggregateError(built.logs);
    const code = await built.outputs[0].text();
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) =>
        new URL(request.url).pathname === "/browser.js"
          ? new Response(code, {
              headers: { "content-type": "text/javascript" },
            })
          : new Response(
              '<form method="POST" action="/default"><input name="name" aria-label="Name" value="default"><input name="action"><input name="method"><input name="reset"><button name="operation" value="override" formaction="/target" formenctype="application/x-www-form-urlencoded">Send</button></form><script type="module" src="/browser.js"></script>',
              { headers: { "content-type": "text/html" } },
            ),
    });
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => !!Reflect.get(window, "control"));
    await page.getByLabel("Name").fill("first");
    await page.getByRole("button").click();
    await page.getByLabel("Name").fill("second");
    await page.getByRole("button").click();
    const observed = await page.evaluate(() => {
      const control = Reflect.get(window, "control") as Control;
      control.settle(0, true);
      return control.calls.map((call) => ({
        url: new URL(call.url).pathname,
        method: call.method,
        body: call.body,
        aborted: call.signal.aborted,
      }));
    });
    expect(observed).toEqual([
      {
        url: "/target",
        method: "POST",
        body: "name=first&action=&method=&reset=&operation=override",
        aborted: true,
      },
      {
        url: "/target",
        method: "POST",
        body: "name=second&action=&method=&reset=&operation=override",
        aborted: false,
      },
    ]);
    await browserExpect(page.getByLabel("Name")).toHaveValue("second");
    await page.evaluate(() =>
      (Reflect.get(window, "control") as Control).settle(1, false),
    );
    await browserExpect(page.getByLabel("Name")).toHaveValue("second");
    await page.getByRole("button").click();
    await page.evaluate(() =>
      (Reflect.get(window, "control") as Control).settle(2, true),
    );
    await browserExpect(page.getByLabel("Name")).toHaveValue("default");
    await page.getByLabel("Name").fill("retained");
    await page.getByRole("button").click();
    await page.evaluate(() => {
      const control = Reflect.get(window, "control") as Control;
      control.dispose();
      control.settle(3, true);
    });
    await browserExpect(page.getByLabel("Name")).toHaveValue("retained");
    expect(
      await page.evaluate(
        () => (Reflect.get(window, "control") as Control).errors,
      ),
    ).toEqual([]);
  } finally {
    await browser.close();
    await server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
