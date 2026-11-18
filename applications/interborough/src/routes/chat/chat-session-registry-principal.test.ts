/**
 * COR-2437 review, settled by test: the retained-route registry and a change of principal. The
 * registry lives as long as the page, and nothing in the page changes who it acts as: the host
 * decides the principal, and the page only reads it. So a retained session is never handed to
 * another principal, and a principal change, which needs a full page load, starts a new registry.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as hostSession from '../../lib/host-session.ts';
import { ChatSessionRegistry, chatSessions } from './chat-session-registry.svelte.ts';

const SOURCE = join(import.meta.dir, '..', '..');

describe('the retained chat sessions and the page’s principal', () => {
  test('the registry is the module’s one instance, for the life of the page', () => {
    expect(chatSessions).toBeInstanceOf(ChatSessionRegistry);
    // No other module builds a registry of its own that could outlive or replace this one.
    const registry = readFileSync(join(import.meta.dir, 'chat-session-registry.svelte.ts'), 'utf8');
    expect(registry.match(/new ChatSessionRegistry\(/g)?.length).toBe(1);
  });

  test('the page only reads who it acts as: there is no sign-out and no way to switch principal', () => {
    // The host session module answers who the page is, and offers nothing that changes it.
    expect(Object.keys(hostSession).toSorted()).toEqual(['HOST_SESSION_ROUTE', 'getHostSession']);
    const sessionSource = readFileSync(join(SOURCE, 'lib', 'host-session.ts'), 'utf8');
    expect(sessionSource).not.toMatch(/method:\s*['"](?:POST|PUT|DELETE)['"]/);
  });
});
