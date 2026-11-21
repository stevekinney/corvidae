import { test } from "bun:test";
import { verifyProductionFixture } from "./run-production-fixture.ts";

test("D03/D07: relocated Bun-only package serves a base path without application source or dependencies", async () => {
  await verifyProductionFixture("/app/", "d07-base", { compression: true });
});
