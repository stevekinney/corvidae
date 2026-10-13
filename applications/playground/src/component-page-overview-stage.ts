/**
 * The Overview live-preview stage and everything that must agree with it.
 *
 * The Overview section mounts one example, shows that example's title, and
 * offers that example's source behind "Show code". All three have to come from
 * the SAME descriptor, or the page presents code that cannot produce the preview
 * above it (COR-441). This module is the single selection point: the server
 * render and the client page both call {@link selectOverviewExample}, and every
 * identifier the stage uses is derived from the descriptor by
 * {@link describeOverviewStage} rather than recomputed at each use site.
 */

/** The slice of an example descriptor the Overview stage reads. */
export type OverviewExampleDescriptor = {
  scenario: string;
  title: string;
  description?: string;
  featured?: boolean;
};

/**
 * Pick the example the Overview previews: the first explicitly featured one, or
 * the first example overall. Undefined when there are no examples, and in
 * snapshot mode, where the Examples section already mounts each scenario once
 * and a second mount would break single-instance assertions.
 */
export function selectOverviewExample<Example extends OverviewExampleDescriptor>(
  examples: readonly Example[],
  snapshotMode: boolean,
): Example | undefined {
  if (snapshotMode) return undefined;
  return examples.find((example) => example.featured === true) ?? examples[0];
}

/** Everything the Overview stage renders, derived from one descriptor. */
export type OverviewStage = {
  /** Scenario that is mounted, and whose source the stage's code panel fetches. */
  scenario: string;
  /** The selected example's real title, shown as the stage label. */
  title: string;
  description: string | undefined;
  /** DOM id of the preview container (also the key for its mount error). */
  mountId: string;
  /** Accordion item id of the stage's "Show code" disclosure. */
  sourceItemId: string;
};

export function describeOverviewStage(example: OverviewExampleDescriptor): OverviewStage {
  return {
    scenario: example.scenario,
    title: example.title,
    description: example.description,
    mountId: `overview-mount-${example.scenario}`,
    sourceItemId: `overview-source-${example.scenario}`,
  };
}
