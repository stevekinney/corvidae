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

/** The component manifest, `components/cinder/components.json`. */
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
