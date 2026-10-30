/**
 * Where hooks, their deliveries, and their sealed signing secrets are kept (COR-1939): records in
 * Bureau's key-value store, each written by compare-and-swap so two writers never both win a
 * revision.
 *
 * @module hook-store
 */

import type { EncryptedValue } from '@lostgradient/cryptography';
import type { ConditionalTextValueStore } from '@lostgradient/storage';

import { type AnswerEncryptionKeys, openSealedAnswer, sealValue } from '../secret-answers.ts';
import {
  HookError,
  type HookDeliveryRecord,
  type HookRecord,
  type HookSecretStore,
} from './hook-types.ts';

/** Every hook record's key starts with this. */
export const HOOK_KEY_PREFIX = 'bureau-hook:v1:';

/** Every delivery record's key starts with this. */
export const HOOK_DELIVERY_KEY_PREFIX = 'bureau-hook-delivery:v1:';

/** Every sealed signing secret the default {@link HookSecretStore} keeps has a key starting with this. */
export const HOOK_SECRET_KEY_PREFIX = 'bureau-hook-secret:v1:';

/** A stored record with the exact text it was read as, which a compare-and-swap write compares. */
export interface Stored<Record> {
  /** The decoded record. */
  readonly record: Record;
  /** The stored text. */
  readonly raw: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHook(raw: string): HookRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value['version'] !== 1 ||
    typeof value['id'] !== 'string' ||
    typeof value['owner'] !== 'string' ||
    typeof value['url'] !== 'string' ||
    !Array.isArray(value['events']) ||
    typeof value['enabled'] !== 'boolean' ||
    typeof value['revision'] !== 'number'
  ) {
    return undefined;
  }
  return value as unknown as HookRecord;
}

function parseDelivery(raw: string): HookDeliveryRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value['version'] !== 1 ||
    typeof value['id'] !== 'string' ||
    typeof value['hookId'] !== 'string' ||
    typeof value['owner'] !== 'string' ||
    typeof value['status'] !== 'string' ||
    !isRecord(value['request']) ||
    !Array.isArray(value['attempts']) ||
    typeof value['revision'] !== 'number' ||
    typeof value['leaseUntil'] !== 'number'
  ) {
    return undefined;
  }
  return value as unknown as HookDeliveryRecord;
}

/** The hook and delivery records of one Bureau. */
export interface HookStore {
  /** The hook, or `undefined` when there is none or its record cannot be read. */
  getHook(id: string): Promise<Stored<HookRecord> | undefined>;
  /** Every readable hook. */
  listHooks(): Promise<readonly HookRecord[]>;
  /** Writes a new hook; `false` when the id is taken. */
  createHook(record: HookRecord): Promise<boolean>;
  /** Replaces `before` with `after`; `false` when the hook is no longer `before`. */
  replaceHook(before: Stored<HookRecord>, after: HookRecord): Promise<boolean>;
  /** Removes `before`; `false` when the hook is no longer `before`. */
  deleteHook(before: Stored<HookRecord>): Promise<boolean>;
  /** The delivery, or `undefined` when there is none or its record cannot be read. */
  getDelivery(id: string): Promise<Stored<HookDeliveryRecord> | undefined>;
  /** Every readable delivery. */
  listDeliveries(): Promise<readonly HookDeliveryRecord[]>;
  /** Writes a new delivery; `false` when the id is taken. */
  createDelivery(record: HookDeliveryRecord): Promise<boolean>;
  /** Replaces `before` with `after`; `false` when the delivery is no longer `before`. */
  replaceDelivery(before: Stored<HookDeliveryRecord>, after: HookDeliveryRecord): Promise<boolean>;
  /** Removes `before`; `false` when the delivery is no longer `before`. */
  deleteDelivery(before: Stored<HookDeliveryRecord>): Promise<boolean>;
  /** Removes every delivery of a hook. */
  deleteDeliveriesOf(hookId: string): Promise<void>;
}

/** Builds the {@link HookStore} over `kv`. */
export function createHookStore(kv: ConditionalTextValueStore): HookStore {
  async function readAll<Record>(
    prefix: string,
    parse: (raw: string) => Record | undefined,
  ): Promise<Record[]> {
    const records: Record[] = [];
    for (const key of await kv.list(prefix)) {
      const raw = await kv.get(key);
      const record = raw === null ? undefined : parse(raw);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  async function readOne<Record>(
    key: string,
    parse: (raw: string) => Record | undefined,
  ): Promise<Stored<Record> | undefined> {
    const raw = await kv.get(key);
    if (raw === null) return undefined;
    const record = parse(raw);
    return record === undefined ? undefined : { record, raw };
  }

  return {
    getHook: (id) => readOne(`${HOOK_KEY_PREFIX}${id}`, parseHook),
    listHooks: () => readAll(HOOK_KEY_PREFIX, parseHook),
    createHook: (record) =>
      kv.conditionalBatch(
        [{ key: `${HOOK_KEY_PREFIX}${record.id}`, expectedValue: null }],
        [{ type: 'set', key: `${HOOK_KEY_PREFIX}${record.id}`, value: JSON.stringify(record) }],
      ),
    replaceHook: (before, after) =>
      kv.conditionalBatch(
        [{ key: `${HOOK_KEY_PREFIX}${before.record.id}`, expectedValue: before.raw }],
        [
          {
            type: 'set',
            key: `${HOOK_KEY_PREFIX}${before.record.id}`,
            value: JSON.stringify(after),
          },
        ],
      ),
    deleteHook: (before) =>
      kv.conditionalBatch(
        [{ key: `${HOOK_KEY_PREFIX}${before.record.id}`, expectedValue: before.raw }],
        [{ type: 'delete', key: `${HOOK_KEY_PREFIX}${before.record.id}` }],
      ),
    getDelivery: (id) => readOne(`${HOOK_DELIVERY_KEY_PREFIX}${id}`, parseDelivery),
    listDeliveries: () => readAll(HOOK_DELIVERY_KEY_PREFIX, parseDelivery),
    createDelivery: (record) =>
      kv.conditionalBatch(
        [{ key: `${HOOK_DELIVERY_KEY_PREFIX}${record.id}`, expectedValue: null }],
        [
          {
            type: 'set',
            key: `${HOOK_DELIVERY_KEY_PREFIX}${record.id}`,
            value: JSON.stringify(record),
          },
        ],
      ),
    replaceDelivery: (before, after) =>
      kv.conditionalBatch(
        [{ key: `${HOOK_DELIVERY_KEY_PREFIX}${before.record.id}`, expectedValue: before.raw }],
        [
          {
            type: 'set',
            key: `${HOOK_DELIVERY_KEY_PREFIX}${before.record.id}`,
            value: JSON.stringify(after),
          },
        ],
      ),
    deleteDelivery: (before) =>
      kv.conditionalBatch(
        [{ key: `${HOOK_DELIVERY_KEY_PREFIX}${before.record.id}`, expectedValue: before.raw }],
        [{ type: 'delete', key: `${HOOK_DELIVERY_KEY_PREFIX}${before.record.id}` }],
      ),
    async deleteDeliveriesOf(hookId) {
      for (const record of await readAll(HOOK_DELIVERY_KEY_PREFIX, parseDelivery)) {
        if (record.hookId === hookId) await kv.delete(`${HOOK_DELIVERY_KEY_PREFIX}${record.id}`);
      }
    },
  };
}

/** A {@link HookSecretStore} that keeps the sealed secrets in `kv`: the default when a host injects none. */
export function createKvHookSecretStore(kv: ConditionalTextValueStore): HookSecretStore {
  return {
    async get(hookId) {
      const raw = await kv.get(`${HOOK_SECRET_KEY_PREFIX}${hookId}`);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as EncryptedValue;
      } catch {
        return undefined;
      }
    },
    async set(hookId, encrypted) {
      await kv.set(`${HOOK_SECRET_KEY_PREFIX}${hookId}`, JSON.stringify(encrypted));
    },
    async delete(hookId) {
      await kv.delete(`${HOOK_SECRET_KEY_PREFIX}${hookId}`);
    },
  };
}

/** The reference a hook's secret is sealed under, so a ciphertext copied to another hook does not open. */
function secretReferenceOf(hookId: string): string {
  return `hook-secret:${hookId}`;
}

/** Seals a hook's signing secret under the current answer key. */
export async function sealHookSecret(
  hookId: string,
  secret: string,
  keys: AnswerEncryptionKeys,
): Promise<EncryptedValue> {
  const sealed = await sealValue(secretReferenceOf(hookId), secret, keys);
  return sealed.encrypted;
}

/**
 * A hook's signing secret in plaintext, for the instant a delivery is signed. Throws `HookError`
 * `secret-unavailable` when there is none, or it does not open (a retired key that is no longer held).
 */
export async function openHookSecret(
  hookId: string,
  secrets: HookSecretStore,
  keys: AnswerEncryptionKeys,
): Promise<string> {
  const encrypted = await secrets.get(hookId);
  if (encrypted === undefined) {
    throw new HookError('secret-unavailable', 'The hook has no signing secret');
  }
  try {
    return await openSealedAnswer(secretReferenceOf(hookId), encrypted, keys);
  } catch {
    throw new HookError('secret-unavailable', 'The hook’s signing secret cannot be opened');
  }
}
