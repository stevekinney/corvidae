/**
 * Writes the design system's per-component files: `components/<Export>/README.md` from
 * `components.json` and the component's own README, and `preview.html` with its `@dsCard` marker
 * for every component that has a preview.
 */

import { categoryLabel, type ComponentManifest, type ManifestComponent } from './manifest.ts';
import type { PreviewPlan } from './previews.ts';

/** The largest README the design system takes before the reference section is truncated. */
export const README_CAP = 64 * 1024;
/** Where a README over the cap is cut, leaving room for the truncation note. */
export const README_TRUNCATE_AT = 63 * 1024;
/** The largest static rendition a preview document may be. */
export const STATIC_PREVIEW_CAP = 256 * 1024;

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * Rewrites a component README's Markdown links for the design system, which has no repository
 * tree: an absolute link stays, a link to another component's README becomes its text plus
 * "(see Export)", and any other relative link becomes its text.
 */
export function rewriteLinks(markdown: string, manifest: ComponentManifest): string {
  const exports = new Map(manifest.components.map((entry) => [entry.id, entry.exportName]));
  return markdown.replace(LINK, (link, text: string, target: string) => {
    if (target.startsWith('http://') || target.startsWith('https://')) return link;
    const hit =
      /components\/([a-z0-9-]+)\/README\.md/.exec(target) ??
      /^\.\.\/([a-z0-9-]+)\/README\.md(#.*)?$/.exec(target);
    const exportName = hit?.[1] === undefined ? undefined : exports.get(hit[1]);
    if (exportName === undefined) return text;
    return text.includes(exportName) ? text : `${text} (see ${exportName})`;
  });
}

/**
 * Turns a component's own README into the guideline page's reference section: drops HTML comments
 * and the leading title, and nests every heading one level deeper.
 */
export function referenceSection(readme: string, manifest: ComponentManifest): string {
  const body = readme
    .replace(/^# .*\n+/, '')
    .replace(/^(#{2,5}) /gm, (_heading, hashes: string) => `#${hashes} `);
  return rewriteLinks(body.replace(/<!--[\s\S]*?-->\n?/g, ''), manifest).trim();
}

function truncateUtf8(text: string, bytes: number): string {
  const encoded = Buffer.from(text, 'utf8');
  let end = Math.min(bytes, encoded.length);
  // Back off a partial character rather than decode it to a replacement character: a UTF-8
  // continuation byte is 0b10xxxxxx, so a cut there would split a character.
  const continues = (byte: number | undefined) => byte !== undefined && byte >= 0x80 && byte < 0xc0;
  while (end > 0 && end < encoded.length && continues(encoded[end])) end -= 1;
  return encoded.subarray(0, end).toString('utf8');
}

/** Writes a component's guideline page. */
export function componentReadme(
  component: ManifestComponent,
  manifest: ComponentManifest,
  leafReadme: string | undefined,
): string {
  const name = component.exportName;
  const exports = new Map(manifest.components.map((entry) => [entry.id, entry.exportName]));
  let purpose = component.purpose.trim();
  if (!purpose.endsWith('.')) purpose += '.';
  const category = categoryLabel(manifest, component.category);
  const parts = [
    `# ${name}`,
    '',
    purpose,
    '',
    `**Category:** ${category} · **Status:** ${component.status} · **Import:** \`import { ${name} } from '${component.import}'\``,
    '',
  ];
  if (component.useWhen?.length) {
    parts.push('## Use when', '', ...component.useWhen.map((item) => `- ${item}`), '');
  }
  if (component.avoidWhen?.length) {
    const reasons = component.avoidWhen.map((item) =>
      typeof item === 'string' ? item : item.reason,
    );
    parts.push('## Avoid when', '', ...reasons.map((reason) => `- ${reason}`), '');
  }
  if (component.related?.length) {
    const related = component.related.map((id) => exports.get(id) ?? id).join(', ');
    parts.push('## Related', '', related, '');
  }
  if (component.a11y?.notes?.length) {
    parts.push('## Accessibility', '', ...component.a11y.notes.map((note) => `- ${note}`), '');
  }
  if (leafReadme !== undefined) {
    parts.push('## Reference', '', referenceSection(leafReadme, manifest), '');
  }
  const text = `${parts.join('\n').trimEnd()}\n`;
  if (Buffer.byteLength(text) <= README_CAP) return text;
  const kept = truncateUtf8(text, README_TRUNCATE_AT);
  const cut = kept.lastIndexOf('\n');
  return `${cut === -1 ? kept : kept.slice(0, cut)}\n\n_Reference truncated; the full README is in the repository at \`components/cinder/src/components/${component.id}/README.md\`._\n`;
}

function exampleTitles(plan: PreviewPlan, limit: number): string {
  const titles = plan.examples
    .map((example) => example.title)
    .join(' · ')
    .replaceAll('"', "'");
  return Array.from(titles).slice(0, limit).join('');
}

/** The light-theme measurement of a rendered preview. */
export type PreviewMeasurement = { height: number; width: number };

/** The card height the design system gives a live preview: its measured height, clamped. */
export function cardHeight(measurement: PreviewMeasurement | undefined): number {
  return Math.max(120, Math.min(4000, Math.trunc(measurement?.height ?? 400) + 8));
}

/** The `preview.html` that loads a component's `preview.js`. */
export function livePreviewHtml(
  component: ManifestComponent,
  manifest: ComponentManifest,
  plan: PreviewPlan,
  measurement: PreviewMeasurement | undefined,
): string {
  const width = Math.trunc(measurement?.width ?? 0);
  const widthAttribute = width > 770 ? ` width=${width + 16}` : '';
  const group = categoryLabel(manifest, component.category);
  return (
    `<!-- @dsCard group="${group}" height=${cardHeight(measurement)}${widthAttribute} subtitle="${exampleTitles(plan, 240)}" -->\n` +
    `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${component.exportName} — preview</title></head>\n<body>\n` +
    `<div id="cinder-preview"></div>\n<script src="./preview.js"></script>\n</body>\n</html>\n`
  );
}

/** A preview captured as static markup, with the styles the component injected at runtime. */
export type StaticSnapshot = { styles: string; html: string; height: number; errors: string[] };

/** The `preview.html` for a static rendition, failing when it is over its cap. */
export function staticPreviewHtml(
  component: ManifestComponent,
  manifest: ComponentManifest,
  plan: PreviewPlan,
  snapshot: StaticSnapshot,
): string {
  const group = categoryLabel(manifest, component.category);
  const style = snapshot.styles ? `<style>${snapshot.styles}</style>` : '';
  const document =
    `<!-- @dsCard group="${group}" height=${Math.min(4000, snapshot.height + 8)} subtitle="Static rendition · ${exampleTitles(plan, 200)}" -->\n` +
    `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${component.exportName} — preview</title>${style}</head>\n<body>\n` +
    `<!-- A static rendition captured from the live component: its bundled editor is larger than a preview script may be. -->\n` +
    `${snapshot.html}\n</body>\n</html>\n`;
  if (Buffer.byteLength(document) > STATIC_PREVIEW_CAP) {
    throw new Error(`static preview too large: ${component.exportName}`);
  }
  return document;
}
