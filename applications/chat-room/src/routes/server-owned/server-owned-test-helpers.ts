import type { APIResponse, Locator } from '@playwright/test';
import { newFixtureMarker } from '../fixture-probe';
import { gotoHydrated } from '../page.svelte-test-helpers';
import { APPROVAL_FOLLOW_UP_TEXT, APPROVAL_NOTE_TEXT, fixtureMarker } from '../streaming-fixture';

export {
  APPROVAL_FOLLOW_UP_TEXT,
  APPROVAL_NOTE_TEXT,
  fixtureMarker,
  gotoHydrated,
  newFixtureMarker,
};

export function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not produced.`);
  return value;
}

/** A title no other test will collide with, in this run or a previous one. */
export const uniqueTitle = (label: string): string =>
  `${label} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type JsonRecord = Record<string, unknown>;

type ConversationReference = { id: string };

type ServerOwnedMessage = { role: string; content: string };

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

function arrayProperty(record: JsonRecord, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`Expected ${key} to be an array.`);
  return value;
}

function conversationReferenceOf(value: unknown): ConversationReference {
  if (!isRecord(value)) throw new Error('Expected conversation to be an object.');
  return { id: stringProperty(value, 'id') };
}

function messageOf(value: unknown): ServerOwnedMessage {
  if (!isRecord(value)) throw new Error('Expected message to be an object.');
  return { role: stringProperty(value, 'role'), content: stringProperty(value, 'content') };
}

export async function readCreatedConversation(
  response: APIResponse,
): Promise<ConversationReference> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('Expected response body to be an object.');
  return conversationReferenceOf(recordProperty(body, 'conversation'));
}

export async function readConversationIds(response: APIResponse): Promise<string[]> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('Expected conversation list body to be an object.');
  return arrayProperty(body, 'conversations').map(
    (conversation) => conversationReferenceOf(conversation).id,
  );
}

export async function readErrorText(response: APIResponse): Promise<string> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('Expected error body to be an object.');
  return stringProperty(body, 'error');
}

export async function readMessageCount(response: APIResponse): Promise<number> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('Expected append body to be an object.');
  const value = body['messageCount'];
  if (typeof value !== 'number') throw new Error('Expected messageCount to be a number.');
  return value;
}

export async function readServerOwnedMessages(
  response: APIResponse,
): Promise<ServerOwnedMessage[]> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('Expected conversation body to be an object.');
  return arrayProperty(body, 'messages').map(messageOf);
}

type PendingApproval = {
  toolName: string;
  callId: string;
  message: string;
  arguments: Record<string, unknown>;
};

function pendingApprovalOf(value: unknown): PendingApproval | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error('Expected pending approval to be an object.');
  const proposedArguments = recordProperty(value, 'arguments');
  return {
    toolName: stringProperty(value, 'toolName'),
    callId: stringProperty(value, 'callId'),
    message: stringProperty(value, 'message'),
    arguments: proposedArguments,
  };
}

export async function readPendingApproval(response: APIResponse): Promise<PendingApproval | null> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('Expected pending approval body to be an object.');
  return pendingApprovalOf(body['pending']);
}

/** Require two rendered frames to agree before treating overflow as settled. */
export function hasStableOverflow(locator: Locator): Promise<boolean> {
  return locator.evaluate(async (element) => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const read = () => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    });
    await frame();
    const first = read();
    await frame();
    const second = read();
    return (
      first.clientHeight > 0 &&
      first.clientHeight === second.clientHeight &&
      first.scrollHeight === second.scrollHeight &&
      second.scrollHeight > second.clientHeight + 1
    );
  });
}
