import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import { z } from 'zod';

import { createTool } from '../create-tool';
import type { Tool } from '../is-tool';
import type { RootJail } from './jail';

/** Default cap on the number of paths returned. */
export const DEFAULT_GLOB_MAX_RESULTS = 500;

/** Options for {@link createGlobTool}. */
export interface CreateGlobToolOptions {
  /** Root jail all matched paths are resolved against. */
  jail: RootJail;
  name?: string;
  description?: string;
  /** Default number of paths returned when the caller omits `maxResults`. */
  defaultMaxResults?: number;
}

/** The `glob` tool's result: matched repository-relative paths, and whether `maxResults` cut them off. */
export interface GlobResult {
  paths: string[];
  truncated: boolean;
}

/**
 * Creates a read-only `glob` tool jailed to `options.jail`'s root.
 *
 * Patterns are repository-relative only — absolute paths and `..`
 * traversal are rejected up front, and the tree scan skips symbolic links.
 * Every match is additionally re-validated
 * through the root jail before being returned, so a symlink planted
 * inside the root cannot be used to enumerate paths outside it.
 */
export function createGlobTool(options: CreateGlobToolOptions): Tool {
  const {
    jail,
    name = 'glob',
    description = 'List repository-relative file paths within the sandboxed root matching a glob pattern.',
    defaultMaxResults = DEFAULT_GLOB_MAX_RESULTS,
  } = options;

  return createTool({
    name,
    description,
    input: z.object({
      pattern: z.string().min(1).describe('Repository-relative glob pattern, e.g. "src/**/*.ts"'),
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Maximum number of paths to return (default ${defaultMaxResults})`),
    }),
    tags: ['coding', 'filesystem', 'readonly', 'search'],
    metadata: { readOnly: true, mutates: false, dangerous: false },
    async execute({ pattern, maxResults }): Promise<GlobResult> {
      assertRepositoryRelativePattern(pattern);
      const effectiveMax = maxResults ?? defaultMaxResults;

      const paths: string[] = [];
      let truncated = false;

      for await (const relativeCandidate of scanPaths(jail.root, pattern, false)) {
        try {
          await jail.resolve(relativeCandidate);
        } catch {
          // Symlink escapes the root (or another traversal issue): skip.
          continue;
        }

        if (paths.length >= effectiveMax) {
          truncated = true;
          break;
        }
        paths.push(relativeCandidate);
      }

      return { paths, truncated };
    },
  });
}

/** Enumerates jail-relative paths without following symlinks, using Node's portable filesystem API. */
export async function* scanPaths(
  root: string,
  pattern: string,
  onlyFiles: boolean,
): AsyncGenerator<string> {
  const matches = picomatch(pattern);
  const queue = [root];
  const paths: string[] = [];
  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!onlyFiles && matches(relativePath)) paths.push(relativePath);
        queue.push(absolutePath);
      } else if ((!onlyFiles || entry.isFile()) && matches(relativePath)) {
        paths.push(relativePath);
      }
    }
  }
  for (const path of paths.toSorted()) yield path;
}

function assertRepositoryRelativePattern(pattern: string): void {
  if (pattern.startsWith('/') || pattern.startsWith('~')) {
    throw new Error(`Glob pattern must be repository-relative, got "${pattern}"`);
  }
  if (pattern.includes('\0')) {
    throw new Error('Glob pattern contains a null byte');
  }
  if (/(^|\/)\.\.(\/|$)/.test(pattern)) {
    throw new Error(`Glob pattern must not traverse outside the root: "${pattern}"`);
  }
}
