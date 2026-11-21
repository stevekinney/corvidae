/**
 * The line under Health's heading that says what the installation keeps its state in ("Running on
 * SQLite"), and the facts Storage details lists, where the full location is: the browser cannot
 * know the state directory, so it reads the SQLite file's directory from the host's paths.
 */
import type { HostPaths } from '../../lib/host-paths.ts';
import { HEALTH_FRAME_COPY as copy } from '../health/health-copy.ts';

/** The directory of `path`, without its trailing separator; the path itself when it names no directory. */
function directoryOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut <= 0 ? path : path.slice(0, cut);
}

/**
 * What the heading's storage line says before "Storage details", for the paths the host gave: the
 * storage in plain words and nothing else ("Running on SQLite"). Where it keeps its state is a path,
 * and no header, description or sentence shows a path (owner, 2026-11-19); the full location is in
 * Storage details, selectable, with a Copy button.
 */
export function runningOnLine(paths: HostPaths | undefined): string {
  if (paths === undefined) return copy.runningUnknown;
  return copy.runningOn(paths.database.kind === 'sqlite' ? copy.sqlite : copy.postgres);
}

/**
 * The backend's name and where it keeps its state, for the facts "Storage details" lists: the
 * location whole, as the host gave it, so the Copy button beside it copies a path that works.
 */
export function storageFacts(paths: HostPaths | undefined): {
  readonly backend: string;
  readonly location: string | undefined;
} {
  if (paths === undefined) return { backend: copy.unknownBackend, location: undefined };
  return paths.database.kind === 'sqlite'
    ? { backend: copy.sqlite, location: directoryOf(paths.database.path) }
    : { backend: copy.postgres, location: paths.database.location };
}
