import { environmentalist } from '@lostgradient/environmentalist';
import { z } from 'zod';

const storageSchema = z.object({
  chatRoomServerOwnedDatabase: z
    .string()
    .optional()
    .meta({ env: 'CHAT_ROOM_SERVER_OWNED_DATABASE' }),
});

const fixtureSchema = z.object({
  hostListener: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'HOST_LISTENER' }),
  teardownMarker: z.string().optional().meta({ env: 'TEARDOWN_MARKER' }),
  blockTeardown: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'BLOCK_TEARDOWN' }),
  reloadMarker: z.string().optional().meta({ env: 'RELOAD_MARKER' }),
  staleMarker: z.string().optional().meta({ env: 'STALE_MARKER' }),
});

function selectedEnvironment(names: readonly string[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/** Resolve storage settings without depending on SvelteKit virtual modules. */
export function readServerOwnedStorageEnvironment() {
  return environmentalist.sync({
    name: 'corvidae-chat-room-storage',
    schema: storageSchema,
    env: selectedEnvironment(['CHAT_ROOM_SERVER_OWNED_DATABASE']),
    argv: [],
    coerce: false,
    sources: ['env', 'defaults'],
  });
}

/** Resolve child-process fixture controls without SvelteKit imports. */
export function readFixtureEnvironment() {
  return environmentalist.sync({
    name: 'corvidae-chat-room-fixtures',
    schema: fixtureSchema,
    env: selectedEnvironment([
      'HOST_LISTENER',
      'TEARDOWN_MARKER',
      'BLOCK_TEARDOWN',
      'RELOAD_MARKER',
      'STALE_MARKER',
    ]),
    argv: [],
    coerce: false,
    sources: ['env', 'defaults'],
  });
}
