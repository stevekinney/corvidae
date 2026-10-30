/**
 * Secret answers to human waits (COR-1816, COR-1920): a field a question marks `writeOnly` and
 * `x-secret` is encrypted before anything holds it, and only the run that asked can read it back.
 *
 * ## The reference
 *
 * A secret field is replaced, everywhere the answer travels after it is checked, by a reference:
 * `{ "secretRef": "<reviewId><field>" }`, where `<field>` is the field's JSON Pointer within the
 * answer (`/password`, `/account/token`), empty when the answer itself is the secret, and any `~`
 * or `/` in the review id is escaped (`~0`, `~1`) so the first `/` always starts the field. It is the
 * shape Armorer recognizes (`packages/armorer/documentation/secrets.md`), so the model, which sees
 * only the reference, can pass it to a tool that declares `acceptsSecrets`, and Armorer asks this
 * module's resolver for the plaintext immediately before the call.
 *
 * ## What is stored
 *
 * The ciphertext lives in one record per reference, under {@link SECRET_ANSWER_KEY_PREFIX} and the
 * SHA-256 of the reference: `{ version: 1, secretRef, reviewId, runId, owner, encrypted,
 * recordedAt }`. `encrypted` is `@lostgradient/cryptography`'s `{ version, ciphertext, iv, keyId }`
 * of the text `{"secretRef":…,"value":…}`, so a ciphertext copied under another reference fails
 * the check {@link openSealedAnswer} makes after decrypting it. The signal that releases the run,
 * the conversation the model reads, the checkpoint, the replay, the audit trail and the command
 * ledgers hold the reference and never the plaintext.
 *
 * An answer's records are written together, after the review's decision is claimed and before the
 * signal is sent, by one compare-and-swap on absent keys: the first claimant's answer is the one
 * every later same-decision re-drive delivers, whole, so what the run is told and what the resolver
 * returns agree.
 *
 * ## Between the ingress and the record
 *
 * An answer is checked as plaintext (it must satisfy its schema, `minLength` included) and then
 * sealed: each secret field becomes a {@link SealedSecretAnswer}, `{ secretRef, encrypted }`. That
 * form may be stored where an ingress must keep the answer to finish it later (the `tasks.respond`
 * claim), and is accepted back in place of the plaintext, after it decrypts under its own
 * reference. A digest of an answer is taken over its reference form ({@link secretReferenceForm}),
 * so a same-decision retry digests alike although each sealing draws a fresh IV, and no digest of a
 * secret's plaintext is ever kept.
 *
 * @module secret-answers
 */

import {
  type EncryptedValue,
  type EncryptionKey,
  CryptographyError,
  decrypt,
  encrypt,
  sha256HexSync,
} from '@lostgradient/cryptography';
import {
  type ConditionalTextValueStore,
  type Storage,
  textValueStore,
} from '@lostgradient/storage';
import { type HumanInputSchema, humanInputSecretFields } from '@lostgradient/operative';
import type { ToolSecretResolver } from 'armorer';

import type { ReviewAnswerIssue } from './review-answer.ts';

/** Every secret-answer record's key starts with this. */
export const SECRET_ANSWER_KEY_PREFIX = 'bureau-secret-answer:v1:';

/**
 * The keys a Bureau seals secret answers with. `current` encrypts every new answer; an answer
 * sealed before a rotation names its key's id, and `retired(keyId)` supplies that key, or
 * `undefined` when it is no longer held, which makes the answer `secret-unavailable`.
 */
export interface AnswerEncryptionKeys {
  /** The key every new secret answer is encrypted with. */
  readonly current: EncryptionKey;
  /** A key retired by a rotation, by its id; `undefined` when it is not held. */
  readonly retired?: (
    keyId: string,
  ) => EncryptionKey | undefined | Promise<EncryptionKey | undefined>;
}

/** A secret field once it is sealed: its reference and the ciphertext of its value. */
export interface SealedSecretAnswer {
  /** The reference the field is known by from here on. */
  readonly secretRef: string;
  /** The encrypted `{ secretRef, value }`. */
  readonly encrypted: EncryptedValue;
}

/** One stored secret answer: the record {@link createSecretAnswerStore} writes. */
interface SecretAnswerRecord {
  readonly version: 1;
  readonly secretRef: string;
  readonly reviewId: string;
  readonly runId: string;
  /** The principal the record belongs to: the owner of the run that asked. */
  readonly owner: string;
  readonly encrypted: EncryptedValue;
  /** Epoch milliseconds the record was written. */
  readonly recordedAt: number;
}

/** What the audit entry of a decision says about each secret it delivered: the field, and a digest of its ciphertext. */
export interface SecretAnswerAuditEntry {
  /** The field's JSON Pointer within the answer (`""` for the answer itself). */
  readonly field: string;
  /** SHA-256 of the stored ciphertext. */
  readonly ciphertextDigest: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The review id as a reference begins: `~` and `/` escaped as `~0` and `~1` (RFC 6901), so the
 * first `/` of a reference always starts the field's pointer. A signal name may hold a `/`, and
 * without the escape one review's field and another review's whole answer could share a reference.
 */
function referencePrefix(reviewId: string): string {
  return reviewId.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * The reference of the secret at `field` (a JSON Pointer) of the answer to `reviewId`: the review id
 * with any `~` and `/` escaped, then the pointer (empty when the answer itself is the secret).
 */
export function secretAnswerReference(reviewId: string, field: string): string {
  return `${referencePrefix(reviewId)}${field}`;
}

/** The field `secretRef` names within the answer to `reviewId`, or `undefined` when it is another review's. */
function fieldOfReference(secretRef: string, reviewId: string): string | undefined {
  const prefix = referencePrefix(reviewId);
  if (secretRef === prefix) return '';
  return secretRef.startsWith(`${prefix}/`) ? secretRef.slice(prefix.length) : undefined;
}

/** Whether `value` is exactly a {@link SealedSecretAnswer}: two own keys, `secretRef` and `encrypted`. */
export function isSealedSecretAnswer(value: unknown): value is SealedSecretAnswer {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 && typeof value['secretRef'] === 'string' && isPlainObject(value['encrypted'])
  );
}

function unescapeSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function segmentsOf(field: string): string[] {
  return field === '' ? [] : field.slice(1).split('/').map(unescapeSegment);
}

/** The value at `field` of `root`, through own plain-object keys only. */
function readField(
  root: unknown,
  field: string,
): { readonly found: boolean; readonly value?: unknown } {
  let node: unknown = root;
  for (const segment of segmentsOf(field)) {
    if (!isPlainObject(node)) return { found: false };
    const entry = Object.getOwnPropertyDescriptor(node, segment);
    if (entry === undefined) return { found: false };
    node = entry.value;
  }
  return { found: true, value: node };
}

/** A copy of `root` with the value at `segments` replaced; `root` when the path does not exist. */
function writeSegments(root: unknown, segments: readonly string[], value: unknown): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  if (!isPlainObject(root) || !Object.hasOwn(root, head)) return root;
  return { ...root, [head]: writeSegments(root[head], rest, value) };
}

/** A copy of `root` with the value at `field` (a JSON Pointer) replaced; `root` when it does not exist. */
function writeField(root: unknown, field: string, value: unknown): unknown {
  return writeSegments(root, segmentsOf(field), value);
}

/**
 * An answer with each secret field (named by `fields`) replaced by its `{ secretRef }`, for what the
 * model, a client, or a digest may see. Only a field that is present is replaced.
 */
export function secretReferenceForm(
  answer: unknown,
  fields: readonly string[],
  reviewId: string,
): unknown {
  let form = answer;
  for (const field of fields) {
    if (readField(form, field).found) {
      form = writeField(form, field, { secretRef: secretAnswerReference(reviewId, field) });
    }
  }
  return form;
}

/** What a digest of an answer that cannot be read as the shape its secret fields need stands for. */
const UNREADABLE_SECRET_ANSWER = { secretAnswer: 'unreadable' } as const;

/**
 * The reference form of an answer as a caller sent it, before it is read as the value its schema
 * asks for, so an ingress can digest a command the same way whether or not the review's schema is
 * still at hand (a retry after the review closed reads the review without it). A secret answer is
 * replaced whole; text or an A2UI `{ "response": text }` is read as JSON first; anything that cannot
 * be read as an object stands for one fixed value, so no digest ever covers a secret's text.
 */
export function secretReferenceFormOfInput(
  input: unknown,
  fields: readonly string[],
  reviewId: string,
): unknown {
  if (fields.length === 0 || input === undefined) return input;
  if (fields.includes('')) return { secretRef: secretAnswerReference(reviewId, '') };
  let value: unknown = input;
  // An A2UI fallback form's `{ "response": text }`, unless `response` is itself a field of the answer.
  if (
    !fields.includes('/response') &&
    isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    typeof value['response'] === 'string'
  ) {
    value = value['response'];
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return UNREADABLE_SECRET_ANSWER;
    }
  }
  if (!isPlainObject(value)) return UNREADABLE_SECRET_ANSWER;
  return secretReferenceForm(value, fields, reviewId);
}

/** `value` with every {@link SealedSecretAnswer} in it, at any depth, reduced to its `{ secretRef }`. */
export function withoutCiphertext(value: unknown): unknown {
  if (isSealedSecretAnswer(value)) return { secretRef: value.secretRef };
  if (Array.isArray(value)) return value.map(withoutCiphertext);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, withoutCiphertext(entry)]),
    );
  }
  return value;
}

/** Every {@link SealedSecretAnswer} in `value`, at any depth. */
function sealedAnswersIn(value: unknown, found: SealedSecretAnswer[] = []): SealedSecretAnswer[] {
  if (isSealedSecretAnswer(value)) found.push(value);
  else if (Array.isArray(value)) for (const entry of value) sealedAnswersIn(entry, found);
  else if (isPlainObject(value))
    for (const entry of Object.values(value)) sealedAnswersIn(entry, found);
  return found;
}

/**
 * The secret fields (named by `fields`) that hold anything but a sealed answer: a value that would
 * reach a signal, or a store, as plaintext. An absent field is not listed.
 */
export function unsealedSecretFields(answer: unknown, fields: readonly string[]): string[] {
  return fields.filter((field) => {
    const held = readField(answer, field);
    return held.found && held.value !== undefined && !isSealedSecretAnswer(held.value);
  });
}

/** Whether `value` holds a {@link SealedSecretAnswer} anywhere. */
export function holdsSealedAnswer(value: unknown): boolean {
  return sealedAnswersIn(value).length > 0;
}

/**
 * The fields of a human wait's answer that its question marks secret, as JSON Pointers: read from
 * its schema, or, for a review read back from the audit trail, from the `secretFields` it kept.
 */
export function secretFieldsOfReview(review: {
  readonly inputSchema?: HumanInputSchema | undefined;
  readonly secretFields?: readonly string[] | undefined;
}): readonly string[] {
  if (review.inputSchema !== undefined) return humanInputSecretFields(review.inputSchema);
  return review.secretFields ?? [];
}

/** Thrown by {@link gateSecretAnswer}: an answer that could reach a secret question unsealed. */
export class SecretAnswerRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretAnswerRefusedError';
  }
}

/**
 * The one gate every answer path passes before it writes anything that covers the answer: a
 * command-ledger claim, a decision-record digest, a task's history (COR-1920).
 *
 * `candidates` are the open human waits the answer could reach, by review id: the one it names,
 * or every open human wait when it names none. Each is read (an error reading one is the caller's,
 * never a reason to go on), and the gate refuses when any of them asks for a secret, or cannot be
 * read, unless the path `seals` the answer and it reaches exactly one wait, which the path then
 * seals for before it records anything. A path that does not seal (A2A records the message itself)
 * is refused whenever a secret wait is among the candidates.
 */
export async function gateSecretAnswer(options: {
  readonly candidates: readonly string[];
  readonly read: (reviewId: string) => Promise<
    | {
        readonly kind: string;
        readonly inputSchema?: HumanInputSchema | undefined;
        readonly secretFields?: readonly string[] | undefined;
      }
    | undefined
  >;
  readonly seals: boolean;
}): Promise<void> {
  const reviews = await Promise.all(options.candidates.map((reviewId) => options.read(reviewId)));
  const risky = reviews.filter(
    (review) =>
      review === undefined ||
      (review.kind === 'human-wait' && secretFieldsOfReview(review).length > 0),
  );
  if (risky.length === 0) return;
  if (options.seals && options.candidates.length === 1) return;
  throw new SecretAnswerRefusedError(
    options.seals
      ? 'This answer could reach a question that asks for a secret; name the wait it answers.'
      : 'This question asks for a secret, which is answered only in the chat, never over A2A.',
  );
}

/** The keyring that can open `value`: the current key, and the retired key it names when it is not that. */
async function keyringFor(
  keys: AnswerEncryptionKeys,
  value: EncryptedValue,
): Promise<{ current: EncryptionKey; retired: EncryptionKey[] }> {
  const keyId: unknown = (value as { keyId?: unknown }).keyId;
  if (typeof keyId !== 'string' || keyId === keys.current.keyId || keys.retired === undefined) {
    return { current: keys.current, retired: [] };
  }
  const retired = await keys.retired(keyId);
  return { current: keys.current, retired: retired === undefined ? [] : [retired] };
}

/** Seals `value` as the secret known by `secretRef`. */
async function sealValue(
  secretRef: string,
  value: string,
  keys: AnswerEncryptionKeys,
): Promise<SealedSecretAnswer> {
  return {
    secretRef,
    encrypted: await encrypt(JSON.stringify({ secretRef, value }), keys.current),
  };
}

/**
 * The plaintext of a sealed answer, after checking that it was sealed under `secretRef`. Throws a
 * `CryptographyError` when it cannot be decrypted (`secret-unavailable` for a key no longer held)
 * and `authentication-failed` when it decrypts to another reference's secret.
 */
export async function openSealedAnswer(
  secretRef: string,
  encrypted: EncryptedValue,
  keys: AnswerEncryptionKeys,
): Promise<string> {
  const text = await decrypt(encrypted, await keyringFor(keys, encrypted));
  let envelope: unknown;
  try {
    envelope = JSON.parse(text) as unknown;
  } catch {
    throw new CryptographyError('malformed-secret');
  }
  if (
    !isPlainObject(envelope) ||
    envelope['secretRef'] !== secretRef ||
    typeof envelope['value'] !== 'string'
  ) {
    throw new CryptographyError('authentication-failed');
  }
  return envelope['value'];
}

/** The outcome of {@link sealSecretAnswer}. */
export type SealedAnswer =
  | {
      readonly ok: true;
      /** The answer with each secret field's plaintext, to check against the schema. */
      readonly plaintext: unknown;
      /** The answer with each secret field sealed, to deliver or store. */
      readonly sealed: unknown;
    }
  | { readonly ok: false; readonly issues: readonly ReviewAnswerIssue[] };

/**
 * Seals the secret fields of an answer to `reviewId`. A field holding text is encrypted. A field
 * already sealed (an answer an ingress stored sealed and now delivers) is opened, to check it
 * against the schema, and kept as it is; one that does not open under its own reference, or names
 * another reference, is refused as an issue at that field. Any other value is left for the schema
 * to refuse.
 */
export async function sealSecretAnswer(input: {
  readonly reviewId: string;
  readonly fields: readonly string[];
  readonly answer: unknown;
  readonly keys: AnswerEncryptionKeys;
}): Promise<SealedAnswer> {
  const { reviewId, fields, keys } = input;
  let plaintext = input.answer;
  let sealed = input.answer;
  const issues: ReviewAnswerIssue[] = [];
  // A sealed answer is accepted only where the question asks for a secret: one anywhere else would
  // be stored under this review's name without being one of its secrets.
  const atFields = fields.filter((field) =>
    isSealedSecretAnswer(readField(input.answer, field).value),
  );
  if (sealedAnswersIn(input.answer).length > atFields.length) {
    issues.push({
      path: [],
      message: 'The answer holds a sealed secret outside the fields its question marks secret',
      code: 'secret',
    });
  }
  for (const field of fields) {
    const held = readField(input.answer, field);
    if (!held.found) continue;
    const secretRef = secretAnswerReference(reviewId, field);
    const path = segmentsOf(field);
    if (typeof held.value === 'string') {
      sealed = writeField(sealed, field, await sealValue(secretRef, held.value, keys));
      continue;
    }
    if (!isSealedSecretAnswer(held.value)) continue;
    try {
      if (held.value.secretRef !== secretRef) throw new CryptographyError('authentication-failed');
      plaintext = writeField(
        plaintext,
        field,
        await openSealedAnswer(secretRef, held.value.encrypted, keys),
      );
    } catch (error) {
      if (!(error instanceof CryptographyError)) throw error;
      issues.push({
        path,
        message: `${path.length === 0 ? 'The answer' : `"${path.join('.')}"`} is not a sealed answer to this question`,
        code: 'secret',
      });
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, plaintext, sealed };
}

function recordKey(secretRef: string): string {
  return `${SECRET_ANSWER_KEY_PREFIX}${sha256HexSync(secretRef)}`;
}

function parseRecord(raw: string | null): SecretAnswerRecord | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isPlainObject(value) ||
      value['version'] !== 1 ||
      typeof value['secretRef'] !== 'string' ||
      typeof value['runId'] !== 'string' ||
      !isPlainObject(value['encrypted'])
    ) {
      return undefined;
    }
    return value as unknown as SecretAnswerRecord;
  } catch {
    return undefined;
  }
}

/** The stored secret answers of one Bureau. */
export interface SecretAnswerStore {
  /**
   * Stores every sealed answer in `payload` for the run that asked, keeping a record that already
   * exists, and returns the payload to deliver (each sealed answer reduced to its `{ secretRef }`)
   * with what the audit entry says of each. Call it after the decision is claimed and before the
   * signal is sent.
   */
  store(
    review: { readonly id: string; readonly runId: string },
    payload: unknown,
    owner: string,
  ): Promise<{ readonly payload: unknown; readonly audit: readonly SecretAnswerAuditEntry[] }>;
  /** The plaintext of `secretRef` for `runId`; throws when it is another run's or cannot be read. */
  resolve(secretRef: string, runId: string): Promise<string>;
  /** {@link sealSecretAnswer} under this store's keys. */
  seal(input: {
    readonly reviewId: string;
    readonly fields: readonly string[];
    readonly answer: unknown;
  }): Promise<SealedAnswer>;
}

/** Thrown by {@link SecretAnswerStore.resolve} for a reference the asking run may not read. Its message names nothing secret. */
export class SecretAnswerUnavailableError extends Error {
  constructor() {
    super('The secret answer is not available to this run.');
    this.name = 'SecretAnswerUnavailableError';
  }
}

/** Bounds the compare-and-swap loop against writers racing for one record. */
const MAXIMUM_STORE_ATTEMPTS = 8;

/** The secret-answer records over a Bureau's key-value view of its storage. */
export function createSecretAnswerStore(options: {
  readonly kv: ConditionalTextValueStore;
  readonly keys: AnswerEncryptionKeys;
  readonly now: () => number;
}): SecretAnswerStore {
  const { kv, now } = options;
  // The keys are the caller's: read once, here.
  const keys: AnswerEncryptionKeys = {
    current: options.keys.current,
    ...(options.keys.retired === undefined ? {} : { retired: options.keys.retired }),
  };

  /** The record a stored answer is, if `raw` is one of `review`'s and names `secretRef`. */
  function recordOf(
    raw: string | null,
    review: { readonly id: string; readonly runId: string },
    secretRef: string,
  ): SecretAnswerRecord | undefined {
    const record = parseRecord(raw);
    return record !== undefined &&
      record.secretRef === secretRef &&
      record.reviewId === review.id &&
      record.runId === review.runId
      ? record
      : undefined;
  }

  /**
   * Stores every secret of one answer, all or none: either this answer's records are all written
   * in one compare-and-swap, or another same-decision answer's already are, and those are kept
   * whole. An answer is never stored as a mix of two submissions' fields.
   */
  async function storeAll(
    review: { readonly id: string; readonly runId: string },
    answers: readonly SealedSecretAnswer[],
    owner: string,
  ): Promise<EncryptedValue[]> {
    const recordKeys = answers.map((answer) => recordKey(answer.secretRef));
    for (let attempt = 0; attempt < MAXIMUM_STORE_ATTEMPTS; attempt += 1) {
      const existing = await Promise.all(recordKeys.map((key) => kv.get(key)));
      if (existing.some((raw) => raw !== null)) {
        // Another answer won: every one of its records must be here, and each is kept.
        return existing.map((raw, index) => {
          const record = recordOf(raw, review, answers[index]!.secretRef);
          if (record === undefined) throw new SecretAnswerUnavailableError();
          return record.encrypted;
        });
      }
      const recordedAt = now();
      const written = await kv.conditionalBatch(
        recordKeys.map((key) => ({ key, expectedValue: null })),
        answers.map((answer, index) => ({
          type: 'set' as const,
          key: recordKeys[index]!,
          value: JSON.stringify({
            version: 1,
            secretRef: answer.secretRef,
            reviewId: review.id,
            runId: review.runId,
            owner,
            encrypted: answer.encrypted,
            recordedAt,
          } satisfies SecretAnswerRecord),
        })),
      );
      if (written) return answers.map((answer) => answer.encrypted);
    }
    throw new SecretAnswerUnavailableError();
  }

  return {
    async store(review, payload, owner) {
      const answers = sealedAnswersIn(payload);
      // Only this review's own references are stored for it.
      const fields = answers.map((answer) => fieldOfReference(answer.secretRef, review.id));
      if (fields.some((field) => field === undefined)) throw new SecretAnswerUnavailableError();
      if (new Set(answers.map((answer) => answer.secretRef)).size !== answers.length) {
        throw new SecretAnswerUnavailableError();
      }
      const stored = answers.length === 0 ? [] : await storeAll(review, answers, owner);
      const audit: SecretAnswerAuditEntry[] = stored.map((encrypted, index) => ({
        field: fields[index]!,
        ciphertextDigest: sha256HexSync(encrypted.ciphertext),
      }));
      return { payload: withoutCiphertext(payload), audit };
    },
    async resolve(secretRef, runId) {
      const record = parseRecord(await kv.get(recordKey(secretRef)));
      if (record === undefined || record.secretRef !== secretRef || record.runId !== runId) {
        throw new SecretAnswerUnavailableError();
      }
      return openSealedAnswer(secretRef, record.encrypted, keys);
    },
    seal: (input) => sealSecretAnswer({ ...input, keys }),
  };
}

/** The id of the run a tool call belongs to, as Operative puts it on the call's execution context. */
function askingRunId(
  executionContext: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const runId = executionContext?.['parentRunId'];
  return typeof runId === 'string' && runId !== '' ? runId : undefined;
}

/**
 * An Armorer `secretResolver` that answers a reference with the plaintext of a secret answer, only
 * for a tool call of the run that asked the question (the call's `executionContext.parentRunId`,
 * which Operative sets to the run's id over anything the caller passed). Any other reference, a
 * call of another run, a record that does not decrypt, and a key no longer held are refused, which
 * Armorer reports as `secret-unavailable`.
 *
 * A Bureau gives it to the toolbox it builds itself. A toolbox an agent's author builds keeps its
 * own options, so a host that wants its tools to read secret answers passes this resolver as that
 * toolbox's `secretResolver`, made with the same storage and keys as the Bureau.
 */
export function createSecretAnswerResolver(options: {
  /** The storage the Bureau is created with. */
  readonly storage: Storage;
  /** The keys the Bureau is created with (`answerEncryption`). */
  readonly keys: AnswerEncryptionKeys;
}): ToolSecretResolver {
  const store = createSecretAnswerStore({
    kv: textValueStore(options.storage, { disposeUnderlyingStorage: false }),
    keys: options.keys,
    now: () => Date.now(),
  });
  return secretResolverOf(store);
}

/** The resolver over a store; see {@link createSecretAnswerResolver}. */
export function secretResolverOf(store: SecretAnswerStore): ToolSecretResolver {
  return async (reference, context) => {
    const runId = askingRunId(context.executionContext);
    if (runId === undefined) throw new SecretAnswerUnavailableError();
    return store.resolve(reference, runId);
  };
}
