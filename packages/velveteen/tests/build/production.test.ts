import { test } from "bun:test";
import { verifyProductionFixture } from "./run-production-fixture.ts";

test("D03/D07: production graph composes with an existing Bun host and hydrates at the root", async () => {
  await verifyProductionFixture("", "d07-root");
});
