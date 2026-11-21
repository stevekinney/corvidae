import { chromium } from "@playwright/test";
import { join } from "node:path";
import { startRuntime } from "./runtime-process.ts";
import { runtimeCases } from "./runtime-cases.ts";
const argument = (name: string) => {
  const direct = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const mode = argument("mode") ?? "production",
  group = argument("group"),
  target = argument("target"),
  caseId = argument("case");
if (mode !== "development" && mode !== "production")
  throw new Error("Unknown mode");
if (target && !["candidate", "reference"].includes(target))
  throw new Error("Unknown target");
const selected = runtimeCases.filter(
  (test) => (!group || test.group === group) && (!caseId || test.id === caseId),
);
if (!selected.length) throw new Error("no selected tests");
const browser = await chromium.launch();
try {
  for (const boundary of ["reference", "candidate"] as const) {
    if (target && target !== boundary) continue;
    const fixture = await startRuntime(boundary, mode);
    const results: unknown[] = [];
    try {
      for (const test of selected) {
        const context = await browser.newContext({
          viewport: { width: 1100, height: 700 },
        });
        const page = await context.newPage();
        const errors: string[] = [];
        const expectedDiagnostics: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "warning" || message.type() === "error") {
            const expected = test.expectedHttpErrors?.some((status) =>
              message
                .text()
                .startsWith(
                  "Failed to load resource: the server responded with a status of " +
                    status +
                    " ",
                ),
            );
            (expected ? expectedDiagnostics : errors).push(message.text());
          }
        });
        try {
          await test.run({ url: fixture.url, browser, page, boundary, mode });
          if (errors.length)
            throw new Error(`Browser diagnostics: ${errors.join("\n")}`);
          results.push({
            id: test.id,
            status: "passed",
            upstream: test.upstream,
            errors,
            expectedDiagnostics,
          });
          console.log(`${boundary}/${mode}: ${test.id} passed`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await Bun.write(
        join(fixture.evidence, `${group ?? "all"}-results.json`),
        JSON.stringify(results, null, 2),
      );
      await fixture.stop();
    }
  }
} finally {
  await browser.close();
}
