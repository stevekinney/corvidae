export type UsageFence = { code: string } | { error: 'no-heading' | 'no-fence' };

/** The first fence after Usage must be Svelte; a later second-level heading ends the section. */
export function extractUsageFence(readmeText: string): UsageFence {
  const lines = readmeText.split('\n');
  const headingIndex = lines.findIndex((line) => /^## Usage\s*$/.test(line));
  if (headingIndex === -1) return { error: 'no-heading' };
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('## ')) return { error: 'no-fence' };
    const fenceOpenMatch = /^```(\S*)\s*$/.exec(line);
    if (!fenceOpenMatch) continue;
    if (fenceOpenMatch[1] !== 'svelte') return { error: 'no-fence' };
    const closeIndex = lines.findIndex(
      (candidate, candidateIndex) => candidateIndex > index && /^```\s*$/.test(candidate),
    );
    if (closeIndex === -1) return { error: 'no-fence' };
    return { code: lines.slice(index + 1, closeIndex).join('\n') };
  }
  return { error: 'no-fence' };
}

export function matchesComponentTag(source: string, pascalName: string): boolean {
  return new RegExp(`<${pascalName}\\b`).test(source);
}
