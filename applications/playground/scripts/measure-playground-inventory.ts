/**
 * Emitted-artifact and route inventory for `measure-playground.ts` (CIN-585).
 *
 * The static export fingerprints immutable assets after it writes them, so artifacts are grouped by
 * their top-level directory and extension rather than by an entry-name convention, and unique
 * artifacts are counted by content hash: two files with identical bytes are one artifact.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

/** The canonical routes a sitemap lists, as pathnames, in document order. */
export function parseSitemapRoutes(sitemapXml: string): string[] {
  return [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(
    (match) => new URL(match[1]!).pathname,
  );
}

/** The group an emitted file is counted under: `<top-level directory or root>:<extension>`. */
export function artifactGroup(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const directory = segments.length > 1 ? segments[0]! : '(root)';
  const extension = extname(normalized).toLowerCase() || '(none)';
  return `${directory}:${extension}`;
}

export type ArtifactFile = { relativePath: string; bytes: number; sha256: string };

export type ArtifactInventory = {
  fileCount: number;
  totalBytes: number;
  uniqueContentCount: number;
  uniqueContentBytes: number;
  groups: Record<string, { files: number; bytes: number }>;
};

/** Summarize emitted files: totals, content-unique totals, and per-group counts. */
export function summarizeArtifacts(files: readonly ArtifactFile[]): ArtifactInventory {
  const groups: Record<string, { files: number; bytes: number }> = {};
  const uniqueBytesByHash = new Map<string, number>();
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.bytes;
    uniqueBytesByHash.set(file.sha256, file.bytes);
    const group = (groups[artifactGroup(file.relativePath)] ??= { files: 0, bytes: 0 });
    group.files += 1;
    group.bytes += file.bytes;
  }
  let uniqueContentBytes = 0;
  for (const bytes of uniqueBytesByHash.values()) uniqueContentBytes += bytes;
  return {
    fileCount: files.length,
    totalBytes,
    uniqueContentCount: uniqueBytesByHash.size,
    uniqueContentBytes,
    groups: Object.fromEntries(
      Object.entries(groups).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat();
}

/** Hash and size every file under an export directory. */
export async function readArtifactFiles(outputDirectory: string): Promise<ArtifactFile[]> {
  const paths = await listFiles(outputDirectory);
  const files = await Promise.all(
    paths.map(async (path) => {
      const contents = await readFile(path);
      return {
        relativePath: relative(outputDirectory, path).replaceAll('\\', '/'),
        bytes: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex'),
      };
    }),
  );
  return files.toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/** The exporter's closing line: `rendered <files> files for <components> components in <seconds>s`. */
export function parseStaticExportSummary(
  output: string,
): { renderedFiles: number; sidebarComponents: number; reportedSeconds: number } | null {
  const match = /\[static-export\] rendered (\d+) files for (\d+) components in ([\d.]+)s/u.exec(
    output,
  );
  if (match === null) return null;
  return {
    renderedFiles: Number(match[1]),
    sidebarComponents: Number(match[2]),
    reportedSeconds: Number(match[3]),
  };
}

/** The server's prebuild line: `Pre-built <succeeded>/<total> page bundles ... (peak resident <n> MB)`. */
export function parseServerPrebuildSummary(
  output: string,
): { succeeded: number; total: number; selfReportedPeakResidentMegabytes: number } | null {
  const match = /Pre-built (\d+)\/(\d+) page bundles.*\(peak resident (\d+) MB\)/u.exec(output);
  if (match === null) return null;
  return {
    succeeded: Number(match[1]),
    total: Number(match[2]),
    selfReportedPeakResidentMegabytes: Number(match[3]),
  };
}

/** Entry count and UTF-8 byte total of one artifact owner map (path → source). */
export function artifactMapFootprint(map: ReadonlyMap<string, string>): {
  entries: number;
  bytes: number;
} {
  let bytes = 0;
  for (const code of map.values()) bytes += Buffer.byteLength(code, 'utf8');
  return { entries: map.size, bytes };
}

export async function readRouteInventory(outputDirectory: string): Promise<string[]> {
  return parseSitemapRoutes(await readFile(join(outputDirectory, 'sitemap.xml'), 'utf8'));
}
