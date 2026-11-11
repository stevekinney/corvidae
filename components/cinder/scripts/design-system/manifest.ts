/**
 * The parts of `components.json` the design-system build reads.
 */

/** One `avoidWhen` entry: a plain reason, or an object carrying it. */
export type AvoidWhen = string | { reason: string };

/** One component in `components.json`. */
export type ManifestComponent = {
  id: string;
  exportName: string;
  import: string;
  category: string;
  status: string;
  purpose: string;
  useWhen?: string[];
  avoidWhen?: AvoidWhen[];
  related?: string[];
  a11y?: { notes?: string[] };
};

/** A component manifest: `components/cinder/components.json`, or the editor's. */
export type ComponentManifest = {
  package: { tokenNamespaces: string[] };
  categories: Record<string, { label: string }>;
  components: ManifestComponent[];
};

/** Returns the display label of a category, failing on a category the manifest does not define. */
export function categoryLabel(manifest: ComponentManifest, category: string): string {
  const entry = Object.hasOwn(manifest.categories, category)
    ? manifest.categories[category]
    : undefined;
  if (!entry) throw new Error(`components.json has no category ${category}`);
  return entry.label;
}

/** One `components.json` the design system reads, with where its components live. */
export type ManifestSource = {
  manifest: ComponentManifest;
  /** The directory holding a folder per component id: its README, examples metadata and styles. */
  componentsDirectory: string;
  /** The module that exports every component in the manifest by its export name. */
  entry: string;
  /** Whether the bundle loads `entry` on a component's first mount instead of when it runs. */
  lazy: boolean;
};

/** Several sources' manifests as one, with the source each component came from. */
export type MergedManifest = {
  /** Every source's components in source order, with the first source's package. */
  manifest: ComponentManifest;
  /** Each component's source, by component id. */
  sources: Map<string, ManifestSource>;
};

/**
 * Merges manifests into one, keeping the first definition of a category and failing on a
 * component id or export name two sources share.
 */
export function mergeManifests(sources: ManifestSource[]): MergedManifest {
  const [first] = sources;
  if (first === undefined) throw new Error('no component manifests to merge');
  const categories = new Map<string, { label: string }>();
  const components: ManifestComponent[] = [];
  const bySource = new Map<string, ManifestSource>();
  const exportNames = new Set<string>();
  for (const source of sources) {
    for (const [key, category] of Object.entries(source.manifest.categories)) {
      if (!categories.has(key)) categories.set(key, category);
    }
    for (const component of source.manifest.components) {
      if (bySource.has(component.id)) {
        throw new Error(`two manifests define component ${component.id}`);
      }
      if (exportNames.has(component.exportName)) {
        throw new Error(`two manifests export ${component.exportName}`);
      }
      bySource.set(component.id, source);
      exportNames.add(component.exportName);
      components.push(component);
    }
  }
  return {
    manifest: {
      package: first.manifest.package,
      categories: Object.fromEntries(categories),
      components,
    },
    sources: bySource,
  };
}
