import type { RuntimeBoundary } from "./runtime-fixture.ts";
import { resolve } from "node:path";

type PutFixture = (path: string, contents: string) => void;

/** Add the O snapshot routes to an existing runtime fixture file map. */
export function addSnapshotFixtures(
  boundary: RuntimeBoundary,
  put: PutFixture,
): void {
  const root = resolve(import.meta.dir, "../..");
  const navigation =
    boundary === "reference"
      ? "import { afterNavigate, goto, onNavigate, snapshot } from '$app/navigation';"
      : `import { afterNavigate, onNavigate, snapshot, getNavigation } from ${JSON.stringify(resolve(root, "src/client/navigation-context.ts"))}; const { goto } = getNavigation();`;
  const corruptedRestore =
    boundary === "candidate" && process.env.VELVETEEN_SNAPSHOT_CORRUPT === "1"
      ? "restore: () => { value = 'wrong restore value'; order = [...order, 'restore']; }"
      : "restore: (next) => { value = next; order = [...order, 'restore']; }";
  const branchLifecycle =
    boundary === "reference"
      ? "import { afterNavigate } from '$app/navigation';"
      : `import { afterNavigate } from ${JSON.stringify(resolve(root, "src/client/navigation-context.ts"))};`;

  put(
    "src/routes/snapshot-o/one/+page.svelte",
    `<script lang="ts">
${navigation}
let value = $state("");
let order = $state<string[]>([]);
let ready = $state(false);
snapshot({ id: "o-snapshot-one", capture: () => value, ${corruptedRestore} });
onNavigate((event) => {
  if (event.type === "link" || (event.type === "goto" && event.shallow))
    value = "changed during onNavigate";
});
afterNavigate(() => {
  order = [...order, "afterNavigate"];
  ready = true;
});
</script>
<main data-snapshot-one>
  <h1>Snapshot one</h1>
  <input data-snapshot-input bind:value />
  <p data-snapshot-ready>{ready ? "ready" : ""}</p>
  <p data-snapshot-order>{order.join(",")}</p>
  <button data-snapshot-shallow onclick={() => goto("/runtime/snapshot-o/one?shallow=1", { shallow: true })}>shallow</button>
  <a href="/runtime/snapshot-o/two">Two</a>
</main>`,
  );
  put(
    "src/routes/snapshot-o/two/+page.svelte",
    `<main data-snapshot-two><h1>Snapshot two</h1><a href="/runtime/snapshot-o/one">One</a></main>`,
  );
  const branchRestore =
    boundary === "candidate" && process.env.VELVETEEN_SNAPSHOT_CORRUPT === "1"
      ? "restore: () => (value = 'wrong restore value')"
      : "restore: (next) => (value = next)";
  put(
    "src/routes/snapshot-o/branch/a/+page.svelte",
    `<script lang="ts">
${branchLifecycle}
let navigations = $state(0);
afterNavigate(() => {
  navigations += 1;
  const key = "__oSnapshotNavigations";
  const current = Number((globalThis as Record<string, unknown>)[key] ?? 0);
  (globalThis as Record<string, unknown>)[key] = current + 1;
});
</script>
<main data-snapshot-branch-a><h1>Branch A</h1><p data-snapshot-branch-nav>{navigations}</p><a href="/runtime/snapshot-o/branch/b">Branch B</a></main>`,
  );
  put(
    "src/routes/snapshot-o/branch/b/+page.svelte",
    `<script lang="ts">
${navigation}
let value = $state("");
snapshot({ id: "o-snapshot-branch-b", capture: () => value, ${branchRestore} });
</script>
<main data-snapshot-branch-b>
  <h1>Branch B</h1>
  <input data-snapshot-branch-input bind:value />
  <a href="/runtime/snapshot-o/branch/a">Branch A</a>
</main>`,
  );
}
