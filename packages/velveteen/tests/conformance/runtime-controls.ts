import { runWithHangGuard } from "@lostgradient/testing/hang-guard";
import { join, resolve } from "node:path";
import { runtimeCases } from "./runtime-cases.ts";
const root = resolve(import.meta.dir, "../..");
const ledger = (await Bun.file(
  join(root, "tests/inventory/runtime-cases.json"),
).json()) as {
  upstream: { sha: string };
  selectedCases: { id: string; source: string; test: string[] }[];
};
if (ledger.upstream.sha !== "a58e0a92c35dbeee161e96c733464dc7397e073a")
  throw new Error("Unexpected oracle identity");
if (
  JSON.stringify(ledger.selectedCases.map((item) => item.id).sort()) !==
  JSON.stringify(runtimeCases.map((item) => item.id).sort())
)
  throw new Error("Runtime ledger is incomplete");
for (const item of ledger.selectedCases) {
  const source = await Bun.file(
    join(root, "tests/reference/upstream", item.source),
  ).text();
  for (const name of item.test)
    if (!source.includes(`test('${name}'`))
      throw new Error(`Upstream test identity is missing: ${name}`);
}
async function run(
  arguments_: string[],
  environment: Record<string, string> = {},
) {
  const child = await runWithHangGuard(
    [
      process.execPath,
      join(import.meta.dir, "runtime-harness.ts"),
      ...arguments_,
    ],
    {
      cwd: root,
      env: { ...process.env, ...environment },
    },
  );
  return {
    arguments: arguments_,
    exit: child.exitCode,
    output: child.stdout.toString() + child.stderr.toString(),
  };
}
const empty = await run(["--case=missing"]);
if (empty.exit === 0 || !empty.output.includes("no selected tests"))
  throw Error(`Empty selection was not rejected: ${empty.output}`);
const wrong = await run(
  ["--mode=production", "--target=candidate", "--case=E03-document"],
  { VELVETEEN_RUNTIME_CORRUPT: "1" },
);
if (wrong.exit === 0 || !wrong.output.includes("universal-layout/fetched/"))
  throw Error(`Corrupt endpoint was not rejected causally: ${wrong.output}`);
const restored = await run([
  "--mode=production",
  "--target=candidate",
  "--case=E03-document",
]);
if (restored.exit !== 0) throw Error(restored.output);
const wrongAction = await run(
  ["--mode=production", "--target=candidate", "--case=G01-enhanced"],
  { VELVETEEN_ACTION_CORRUPT: "1" },
);
if (wrongAction.exit === 0 || !wrongAction.output.includes("Saved Alice"))
  throw Error(`Corrupt action did not fail causally: ${wrongAction.output}`);
const restoredAction = await run([
  "--mode=production",
  "--target=candidate",
  "--case=G01-enhanced",
]);
if (restoredAction.exit !== 0) throw Error(restoredAction.output);
const wrongLayout = await run(
  ["--mode=production", "--target=candidate", "--case=K-layout-inheritance"],
  { VELVETEEN_LAYOUT_K_CORRUPT: "1" },
);
if (
  wrongLayout.exit === 0 ||
  !wrongLayout.output.includes("K root reset excludes the ordinary layout") ||
  !wrongLayout.output.includes('Expected substring: not "data-k-layout"')
)
  throw Error(
    `Corrupt layout reset did not fail causally: ${wrongLayout.output}`,
  );
const restoredLayout = await run([
  "--mode=production",
  "--target=candidate",
  "--case=K-layout-inheritance",
]);
if (restoredLayout.exit !== 0) throw Error(restoredLayout.output);
const wrongTyped = await run(
  ["--mode=production", "--target=candidate", "--case=L-typed-matchers"],
  { VELVETEEN_TYPED_MATCHER_CORRUPT: "1" },
);
if (wrongTyped.exit === 0 || !wrongTyped.output.includes("number: 0 (number)"))
  throw Error(
    `Corrupt typed matcher was not rejected causally: ${wrongTyped.output}`,
  );
const restoredTyped = await run([
  "--mode=production",
  "--target=candidate",
  "--case=L-typed-matchers",
]);
if (restoredTyped.exit !== 0) throw Error(restoredTyped.output);
const wrongOptionalRest = await run(
  [
    "--mode=production",
    "--target=candidate",
    "--case=M-optional-rest-matchers",
  ],
  { VELVETEEN_OPTIONAL_REST_CORRUPT: "1" },
);
if (
  wrongOptionalRest.exit === 0 ||
  !wrongOptionalRest.output.includes('Received: "{\\"path\\":\\"install\\"}"')
)
  throw Error(
    `Corrupt optional rest params were not rejected causally: ${wrongOptionalRest.output}`,
  );
const restoredOptionalRest = await run([
  "--mode=production",
  "--target=candidate",
  "--case=M-optional-rest-matchers",
]);
if (restoredOptionalRest.exit !== 0) throw Error(restoredOptionalRest.output);
const snapshotArguments = [
  "--mode=production",
  "--target=candidate",
  "--case=O-snapshots",
];
const wrongSnapshot = await run(snapshotArguments, {
  VELVETEEN_SNAPSHOT_CORRUPT: "1",
});
if (
  wrongSnapshot.exit === 0 ||
  !wrongSnapshot.output.includes('Expected: "one"') ||
  !wrongSnapshot.output.includes('Received: "wrong restore value"')
)
  throw Error(
    `Corrupt snapshot did not fail causally: ${wrongSnapshot.output}`,
  );
const restoredSnapshot = await run(snapshotArguments);
if (restoredSnapshot.exit !== 0) throw Error(restoredSnapshot.output);
const announcementArguments = [
  "--mode=production",
  "--target=candidate",
  "--case=P-route-announcements",
];
const staleAnnouncement = await run(announcementArguments, {
  VELVETEEN_ANNOUNCER_STALE_TITLE: "1",
});
if (
  staleAnnouncement.exit === 0 ||
  !staleAnnouncement.output.includes("P destination announcement value") ||
  !staleAnnouncement.output.includes('Expected: "Announcements destination"') ||
  !staleAnnouncement.output.includes('Received: "Announcements source"')
)
  throw Error(
    `Stale title did not fail the destination announcement: ${staleAnnouncement.output}`,
  );
const restoredAnnouncement = await run(announcementArguments);
if (restoredAnnouncement.exit !== 0) throw Error(restoredAnnouncement.output);
const transportArguments = [
  "--mode=production",
  "--target=candidate",
  "--case=Q-transport-snapshots",
];
const plainObjectTransport = await run(transportArguments, {
  VELVETEEN_TRANSPORT_PLAIN_OBJECT: "1",
});
if (
  plainObjectTransport.exit === 0 ||
  !plainObjectTransport.output.includes("Q restored snapshot instance") ||
  !plainObjectTransport.output.includes('Expected: "true"') ||
  !plainObjectTransport.output.includes('Received: "false"')
)
  throw Error(
    `Plain-object transport did not fail the instance assertion: ${plainObjectTransport.output}`,
  );
const restoredTransport = await run(transportArguments);
if (restoredTransport.exit !== 0) throw Error(restoredTransport.output);
const actionTransportArguments = [
  "--mode=production",
  "--target=candidate",
  "--case=U-action-custom-transport",
];
const plainObjectActionTransport = await run(actionTransportArguments, {
  VELVETEEN_ACTION_TRANSPORT_PLAIN_OBJECT: "1",
});
if (
  plainObjectActionTransport.exit === 0 ||
  !plainObjectActionTransport.output.includes("U enhanced instance") ||
  !plainObjectActionTransport.output.includes('Expected: "true"') ||
  !plainObjectActionTransport.output.includes('Received: "false"')
)
  throw Error(
    `Plain-object action transport did not fail the instance assertion: ${plainObjectActionTransport.output}`,
  );
const restoredActionTransport = await run(actionTransportArguments);
if (restoredActionTransport.exit !== 0)
  throw Error(restoredActionTransport.output);
const routeEscapeArguments = [
  "--mode=production",
  "--target=candidate",
  "--case=R-route-escapes",
];
const doubleEncodedRoute = await run(routeEscapeArguments, {
  VELVETEEN_ROUTE_ESCAPE_DOUBLE_ENCODE: "1",
});
if (
  doubleEncodedRoute.exit === 0 ||
  !doubleEncodedRoute.output.includes("hash browser route label") ||
  !doubleEncodedRoute.output.includes('Expected: "static-hash"') ||
  !doubleEncodedRoute.output.includes('Received: "dynamic-%23"')
)
  throw Error(
    `Double encoding did not fail route selection: ${doubleEncodedRoute.output}`,
  );
const restoredRouteEscape = await run(routeEscapeArguments);
if (restoredRouteEscape.exit !== 0) throw Error(restoredRouteEscape.output);
const batchArguments = [
  "--mode=production",
  "--target=candidate",
  "--case=V-query-batching",
];
const splitBatch = await run(batchArguments, {
  VELVETEEN_REMOTE_SPLIT_BATCHES: "1",
});
if (
  splitBatch.exit === 0 ||
  !splitBatch.output.includes("V batch wire requests") ||
  !splitBatch.output.includes("Expected length: 1") ||
  !splitBatch.output.includes("Received length: 4")
)
  throw Error(
    `Split query batch did not fail the wire count: ${splitBatch.output}`,
  );
const restoredBatch = await run(batchArguments);
if (restoredBatch.exit !== 0) throw Error(restoredBatch.output);
await Bun.write(
  join(root, ".velveteen/evidence/runtime-controls.json"),
  JSON.stringify(
    {
      ledger,
      empty,
      wrong,
      restored,
      wrongAction,
      restoredAction,
      wrongLayout,
      restoredLayout,
      wrongTyped,
      restoredTyped,
      wrongOptionalRest,
      restoredOptionalRest,
      wrongSnapshot,
      restoredSnapshot,
      staleAnnouncement,
      restoredAnnouncement,
      plainObjectTransport,
      restoredTransport,
      plainObjectActionTransport,
      restoredActionTransport,
      doubleEncodedRoute,
      restoredRouteEscape,
      splitBatch,
      restoredBatch,
    },
    null,
    2,
  ),
);
console.log(
  "Runtime controls passed: pinned case identities, empty selection rejection, and causal corruption/restoration checks",
);
