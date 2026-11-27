import { test } from "bun:test";
import { verifyProductionFixture } from "./run-production-fixture.ts";

test("D03/D07: production graph composes with an existing Bun host and hydrates at the root", async () => {
  await verifyProductionFixture("", "d07-root");
});

test("application plugins rewrite the installed browser graph without rewriting the server", async () => {
  await verifyProductionFixture("", "application-browser-plugin", {
    browserPlugins: [
      {
        name: "fixture-browser-label",
        setup(build) {
          build.onLoad({ filter: /fixture-label\.ts$/ }, () => ({
            contents: "export const incrementedLabel = 'Browser only label';",
            loader: "ts",
          }));
        },
      },
    ],
    incrementedLabel: "Browser only label",
  });
});
