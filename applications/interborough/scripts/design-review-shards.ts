/**
 * How the design-review capture is split over runners. An unfiltered capture is about a thousand
 * tests and, with 1920 pixels added to every 1280 capture, runs well past the time one runner has,
 * so `.github/workflows/design-review-capture.yml` runs each color scheme as its own set of shards
 * and merges their outputs (`scripts/design-review-merge.ts`). A shard is a set of whole
 * specification files: `--shard <index>/<count>` on the capture command keeps the files
 * {@link planShards} puts in that shard. The plan is a pure function of the specification list, so
 * every shard of every scheme computes the same one.
 */

/** How many shards each color scheme's capture is split into; the workflow's matrix lists exactly these. */
export const SHARD_COUNT = 6;

/**
 * About how long each specification takes to capture, in seconds, from the sweep of 2026-11-19
 * (`playwright-light.json`: 4,104 seconds for 48 files at one worker). Only the proportions matter. A
 * specification missing here weighs {@link DEFAULT_WEIGHT}, so a new file lands somewhere sensible
 * and a test (`design-review-shards.test.ts`) keeps the plan balanced.
 */
export const SPECIFICATION_WEIGHTS: Readonly<Record<string, number>> = {
  '15-view-states.spec.ts': 800,
  'responsive.spec.ts': 570,
  'hooks.spec.ts': 560,
  '00-showcase.spec.ts': 500,
  'health-storage.spec.ts': 120,
  'settings-models.spec.ts': 115,
  'health-workers-states.spec.ts': 100,
  'list-empty-states.spec.ts': 100,
  'agent-plugin-editing.spec.ts': 100,
  'schedules-detail.spec.ts': 85,
  'workflow-builder-cards.spec.ts': 80,
  'chat-responsive.spec.ts': 70,
  'settings-general.spec.ts': 70,
  'health-audit-states.spec.ts': 65,
  'chat-list.spec.ts': 60,
  'chat-page.spec.ts': 50,
  'settings-plugins.spec.ts': 50,
  'schedules-new.spec.ts': 50,
  'schedules-states.spec.ts': 50,
  'chat-archive.spec.ts': 45,
  'agent-duplicate.spec.ts': 40,
  'health-overview.spec.ts': 40,
  'chat-states.spec.ts': 40,
  'chat-availability.spec.ts': 40,
  'checks-states.spec.ts': 60,
  // Twenty-four states at four widths each, every one reached from a fresh page.
  'confirm-dialog-states.spec.ts': 150,
  // Fourteen states at four widths each, every one reached from a fresh mount of the panel.
  'schedule-editor-states.spec.ts': 110,
  // Six states at four widths each, every one reached from a fresh mount of the panel.
  'failure-explanation-states.spec.ts': 50,
  // Three states at four widths each, every one from a fresh failed run of the failing agent.
  'run-explain-further.spec.ts': 45,
  // Ten states at four widths each, one panel mount apiece.
  'run-timeline-states.spec.ts': 80,
  // Eight states at two to three widths each (four with the repeats at 1920 and 320), one page apiece.
  'copy-and-inline-markdown-states.spec.ts': 70,
};

/** The weight of a specification the table does not list. */
export const DEFAULT_WEIGHT = 30;

/** A shard of a plan: its one-based number, the specifications it captures, and their summed weight. */
export interface Shard {
  readonly index: number;
  readonly specifications: readonly string[];
  readonly weight: number;
}

/** The weight of one specification, from its path. */
export function weightOf(specification: string): number {
  const name = specification.split('/').at(-1) ?? specification;
  return Object.hasOwn(SPECIFICATION_WEIGHTS, name)
    ? (SPECIFICATION_WEIGHTS[name] ?? DEFAULT_WEIGHT)
    : DEFAULT_WEIGHT;
}

/**
 * Splits `specifications` into `count` shards of about equal weight: the heaviest first, each into
 * the lightest shard so far (ties to the lower index), then each shard's files back in list order.
 * Every specification is in exactly one shard; a shard may be empty when there are fewer files than
 * shards.
 */
export function planShards(specifications: readonly string[], count: number): Shard[] {
  const shards = Array.from({ length: count }, (_, position) => ({
    index: position + 1,
    members: [] as string[],
    weight: 0,
  }));
  const heaviestFirst = specifications
    .map((specification, order) => ({ specification, order, weight: weightOf(specification) }))
    .toSorted((left, right) => right.weight - left.weight || left.order - right.order);
  for (const { specification, weight } of heaviestFirst) {
    const lightest = shards.reduce((best, shard) => (shard.weight < best.weight ? shard : best));
    lightest.members.push(specification);
    lightest.weight += weight;
  }
  return shards.map(({ index, members, weight }) => ({
    index,
    specifications: specifications.filter((specification) => members.includes(specification)),
    weight,
  }));
}

/** A `--shard` value, `<index>/<count>` with `1 <= index <= count`, or the usage error to print. */
export function parseShard(value: string): { index: number; count: number } | string {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (match === null || index < 1 || count < 1 || index > count) {
    return `--shard must be <index>/<count> with 1 <= index <= count, not "${value}"`;
  }
  return { index, count };
}
