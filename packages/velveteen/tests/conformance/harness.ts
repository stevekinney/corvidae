import { parseArgs } from "node:util";
import { chromium, expect } from "@playwright/test";
import { startFixture } from "./fixture-process.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: "string" },
    target: { type: "string" },
    case: { type: "string", default: "proof" },
  },
});
const cases = ["proof"].filter((name) => name === values.case);
const modes = (["development", "production"] as const).filter(
  (mode) => !values.mode || values.mode === mode,
);
const targets = (["reference", "candidate"] as const).filter(
  (target) => !values.target || values.target === target,
);
if (cases.length * modes.length * targets.length === 0)
  throw new Error("no selected tests");

const browser = await chromium.launch();
let completed = 0;
try {
  for (const mode of modes)
    for (const target of targets) {
      const server = await startFixture(target, mode);
      const page = await browser.newPage();
      try {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (["warning", "error"].includes(message.type()))
            errors.push(message.text());
        });
        const proof = await page.goto(new URL("/proof", server.url).href);
        expect(proof?.status(), `${target}/${mode} proof HTTP status`).toBe(
          200,
        );
        await expect(
          page.getByText("Original: 0", { exact: true }),
        ).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute(
          "data-hydrated",
          "true",
        );
        await page.getByRole("button").click();
        await expect(
          page.getByText("Original: 1", { exact: true }),
        ).toBeVisible();
        expect(errors, `${target}/${mode} browser errors`).toEqual([]);
        const endpoint = await fetch(new URL("/endpoint", server.url));
        expect(endpoint.status).toBe(200);
        const payload: unknown = await endpoint.json();
        if (JSON.stringify(payload) !== JSON.stringify({ status: "ok" }))
          throw new Error(
            `endpoint expected {"status":"ok"}, received ${JSON.stringify(payload)}`,
          );
        const missing = await fetch(new URL("/missing.txt", server.url), {
          headers: { accept: "application/json" },
        });
        expect(missing.status).toBe(404);
        completed += 1;
        console.log(`P02 passed ${target}/${mode}`);
      } finally {
        await page.close();
        await server.stop();
      }
    }
} finally {
  await browser.close();
}
if (completed !== modes.length * targets.length)
  throw new Error("incomplete execution matrix");
console.log(
  `P02 completed ${completed} real reference/candidate execution cells`,
);
