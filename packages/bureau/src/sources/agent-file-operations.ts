/**
 * The file-system operations the agent directory needs, behind one seam so a test can record
 * exactly what a write did (COR-1524). The default is `node:fs/promises`, which Bun implements.
 *
 * @module agent-file-operations
 */

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';

/** One entry of the agent directory that could be an agent file. */
export interface AgentDirectoryEntry {
  readonly name: string;
  /** A regular file, or a symbolic link to one. */
  readonly isFile: boolean;
}

export interface AgentFileOperations {
  /** The directory's entries, or `undefined` when the directory does not exist. */
  listDirectory(directory: string): Promise<readonly AgentDirectoryEntry[] | undefined>;
  /** A file's size in bytes, or `undefined` when it is gone. */
  size(path: string): Promise<number | undefined>;
  /** A file's bytes, or `undefined` when it is gone. */
  read(path: string): Promise<Uint8Array | undefined>;
  makeDirectory(directory: string): Promise<void>;
  /** Write `bytes` to a new file that must not exist yet; the file is private to its owner. */
  writeTemporary(path: string, bytes: Uint8Array): Promise<void>;
  /** Move `from` over `to` in one step. */
  rename(from: string, to: string): Promise<void>;
  /** Delete a file. A file that is already gone is not an error. */
  remove(path: string): Promise<void>;
}

/** Whether `error` is a Node error with `code`. */
export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code;
}

export const nodeAgentFileOperations: AgentFileOperations = {
  async listDirectory(directory) {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const found: AgentDirectoryEntry[] = [];
      for (const entry of entries) {
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            const linked = await stat(`${directory}/${entry.name}`);
            isFile = linked.isFile();
          } catch {
            isFile = false;
          }
        }
        found.push({ name: entry.name, isFile });
      }
      return found;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return undefined;
      throw error;
    }
  },

  async size(path) {
    try {
      const info = await stat(path);
      return info.size;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    }
  },

  async read(path) {
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    }
  },

  async makeDirectory(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  },

  async writeTemporary(path, bytes) {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  },

  async rename(from, to) {
    await rename(from, to);
  },

  async remove(path) {
    try {
      await unlink(path);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  },
};
