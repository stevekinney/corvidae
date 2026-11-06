/**
 * The line under Health's heading that says where the installation keeps its state: "Running on
 * SQLite in ~/.interborough". The browser cannot know the state directory, so it reads the SQLite
 * file's directory from the host's paths and writes a home directory as `~`, the way a person
 * says it.
 */
import type { HostPaths } from '../../lib/host-paths.ts';
import { HEALTH_FRAME_COPY as copy } from '../health/health-copy.ts';

/** The directory of `path`, without its trailing separator; the path itself when it names no directory. */
function directoryOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut <= 0 ? path : path.slice(0, cut);
}

/** `directory` with a leading home directory (`/Users/<name>`, `/home/<name>`) written as `~`. */
export function abbreviateHome(directory: string): string {
  return directory.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/, '~');
}

/** What the heading's storage line says before "Storage details", for the paths the host gave. */
export function runningOnLine(paths: HostPaths | undefined): string {
  if (paths === undefined) return copy.runningUnknown;
  return paths.database.kind === 'sqlite'
    ? copy.runningOn(copy.sqlite, abbreviateHome(directoryOf(paths.database.path)))
    : copy.runningOn(copy.postgres, paths.database.location);
}

/** The backend's name and where it keeps its state, for the facts "Storage details" lists. */
export function storageFacts(paths: HostPaths | undefined): {
  readonly backend: string;
  readonly location: string | undefined;
} {
  if (paths === undefined) return { backend: copy.unknownBackend, location: undefined };
  return paths.database.kind === 'sqlite'
    ? { backend: copy.sqlite, location: abbreviateHome(directoryOf(paths.database.path)) }
    : { backend: copy.postgres, location: paths.database.location };
}
