import { definePlugin } from '@lostgradient/interborough-plugin';
import { createCodingTools } from 'armorer/coding';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const ROOT_ID_PATTERN = /^[a-z][a-z0-9-]{0,19}$/;

const rootConfiguration = z.object({
  id: z.string(),
  path: z.string(),
  description: z.string().min(1),
});

const configuration = z.object({ roots: z.array(rootConfiguration).default([]) });

type WorkspaceRoot = z.output<typeof rootConfiguration>;

function validateRoot(root: WorkspaceRoot, seen: Set<string>): void {
  if (!ROOT_ID_PATTERN.test(root.id)) {
    throw new Error(`Workspace root "${root.id}" has an invalid id.`);
  }
  if (seen.has(root.id)) {
    throw new Error(`Workspace root "${root.id}" is declared more than once.`);
  }
  seen.add(root.id);
  if (!isAbsolute(root.path)) {
    throw new Error(`Workspace root "${root.id}" must use an absolute path.`);
  }
  try {
    accessSync(root.path, constants.R_OK);
    if (!statSync(root.path).isDirectory()) {
      throw new Error('it is not a directory');
    }
  } catch (error) {
    const detail =
      error instanceof Error && error.message === 'it is not a directory'
        ? error.message
        : 'it does not exist or cannot be read';
    throw new Error(`Workspace root "${root.id}" ${detail}.`, { cause: error });
  }
}

function toolDescription(action: string, root: WorkspaceRoot): string {
  return `${action} within the "${root.id}" workspace root. ${root.description}`;
}

/** The disabled-by-default plugin that contributes tools for configured workspace roots. */
export default definePlugin({
  name: 'workspace',
  version: '1.0.0',
  description: 'Read-only file tools for explicitly configured workspace roots.',
  enabledByDefault: false,
  configuration,
  setup({ configuration: settings }) {
    const seen = new Set<string>();
    const tools = settings.roots.flatMap((root) => {
      validateRoot(root, seen);
      const coding = createCodingTools({
        root: root.path,
        glob: {
          name: `${root.id}-glob`,
          description: toolDescription('List files', root),
        },
        grep: {
          name: `${root.id}-grep`,
          description: toolDescription('Search files', root),
        },
        readFile: {
          name: `${root.id}-read-file`,
          description: toolDescription('Read a file', root),
        },
      });
      return [coding.glob, coding.grep, coding.readFile];
    });
    return { tools };
  },
});
