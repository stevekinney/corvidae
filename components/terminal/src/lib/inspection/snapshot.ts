import { findHttpsLinks } from '../components/terminal/terminal-links.ts';
import type { TerminalProjection } from '../components/terminal/terminal-projection.ts';
import type { TextExport } from './export.ts';
import { SNAPSHOT_LINK_LIMIT } from './inspection-types.ts';

/**
 * An immutable, bounded copy of the retained output at one moment, for the accessible output
 * dialog. Nothing that happens to the terminal afterwards changes it; only a new capture does.
 */
export type Snapshot = Readonly<{
  text: string;
  truncated: boolean;
  /** UTF-8 bytes in `text`. */
  bytes: number;
  /** The attachment it was read from. */
  generation: number;
  /** Visible HTTPS addresses in `text`, in order and without repeats, bounded. */
  links: readonly string[];
  /**
   * The plain-text file the Download action saves, taken with the snapshot, so the message about
   * it can be shown before anything is saved and the saved file is what that message described.
   */
  export: Readonly<TextExport>;
}>;

/**
 * The distinct visible HTTPS addresses in `text`, first appearances first, at most `limit`. The
 * policy is the terminal's one link policy: a complete, credential-free `https:` address seen as
 * text. A hidden OSC 8 destination is not text, so it is not here; neither is a path or any other
 * scheme.
 */
export function snapshotLinks(text: string, limit: number = SNAPSHOT_LINK_LIMIT): string[] {
  const seen = new Set<string>();
  for (const { url } of findHttpsLinks(text)) {
    seen.add(url);
    if (seen.size === limit) break;
  }
  return [...seen];
}

export function captureSnapshot(
  projection: TerminalProjection,
  generation: number,
  exported: TextExport,
): Snapshot {
  return Object.freeze({
    text: projection.text,
    truncated: projection.truncated,
    bytes: projection.bytes,
    generation,
    links: Object.freeze(snapshotLinks(projection.text)),
    export: Object.freeze(exported),
  });
}
