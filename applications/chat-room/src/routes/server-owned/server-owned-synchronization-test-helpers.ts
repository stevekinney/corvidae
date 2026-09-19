import type { APIResponse } from '@playwright/test';
import type { ServerOwnedConversationSnapshot } from '../../lib/server-owned-snapshot.ts';
import { gotoHydrated } from '../page.svelte-test-helpers';
import { fixtureMarker } from '../streaming-fixture';

export { fixtureMarker, gotoHydrated };
export type { ServerOwnedConversationSnapshot };

export const title = `Synchronization ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type JsonRecord = Record<string, unknown>;

type ConversationReference = { id: string };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringProperty(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string.`);
  return value;
}

function recordProperty(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`Expected ${key} to be an object.`);
  return value;
}

function isSnapshot(value: unknown): value is ServerOwnedConversationSnapshot {
  if (!isRecord(value)) return false;
  const conversation = value['conversation'];
  if (!isRecord(conversation)) return false;
  if (!Array.isArray(conversation['ids'])) return false;
  if (!conversation['ids'].every((id) => typeof id === 'string')) return false;
  if (!isRecord(conversation['messages'])) return false;
  return isRecord(value['turnFailures']);
}

export async function readCreatedConversation(
  response: APIResponse,
): Promise<ConversationReference> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('Expected create response to be an object.');
  const conversation = recordProperty(body, 'conversation');
  return { id: stringProperty(conversation, 'id') };
}

export async function readServerOwnedSnapshot(
  response: APIResponse,
): Promise<ServerOwnedConversationSnapshot> {
  const body: unknown = await response.json();
  if (!isSnapshot(body)) throw new Error('Expected server-owned conversation snapshot.');
  return body;
}

export function latestUserMessageId(snapshot: ServerOwnedConversationSnapshot): string {
  for (let index = snapshot.conversation.ids.length - 1; index >= 0; index -= 1) {
    const id = snapshot.conversation.ids[index];
    if (id !== undefined && snapshot.conversation.messages[id]?.role === 'user') return id;
  }
  throw new Error('Snapshot did not contain a user message.');
}
