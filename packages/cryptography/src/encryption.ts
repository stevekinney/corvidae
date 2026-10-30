/**
 * Authenticated encryption for stored secrets: AES-256-GCM through Web Crypto, with a keyring so a
 * key can be rotated without losing values written under the old one.
 *
 * Design, in the order a reviewer is likely to ask:
 *
 * - **Fresh IV per encryption.** Every `encrypt` draws a new random 96-bit IV from
 *   `crypto.getRandomValues`; an IV is never derived, counted, or reused. With random 96-bit IVs the
 *   collision risk stays negligible up to roughly 2^32 encryptions under one key, so rotate a key
 *   long before it has sealed that many values.
 * - **Key id.** A key's id is `hex(SHA-256("corvidae.cryptography.key-id.v1" || rawKey))`
 *   truncated to 12 bytes: 24 lowercase hexadecimal characters, which is a valid Bungalow secret-name
 *   suffix (`answer-encryption-key-<keyId>`). SHA-256 is preimage-resistant and the key is 256 bits of entropy, so the
 *   id reveals nothing usable about the key, and it is derived rather than stored, so a host can
 *   recompute the id (and the Bungalow secret name that embeds it) from the key alone.
 * - **Additional authenticated data.** The version tag and the key id are bound into the GCM
 *   additional data, so rewriting either on a stored value fails authentication instead of silently
 *   selecting a different key or algorithm.
 * - **Version.** Stored values carry `version: 1`. It is the only hook for a future algorithm
 *   change, and a stored value is long-lived, so the tag is cheap insurance on a persisted shape.
 * - **Errors.** Every failure is a {@link CryptographyError} with a fixed message and a code. No
 *   message contains key material or plaintext, and WebCrypto's own error is never re-thrown.
 */

/** The only stored-value version this module reads and writes. */
const STORED_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_BYTES = 12;
const KEY_ID_DOMAIN = 'corvidae.cryptography.key-id.v1';
const ADDITIONAL_DATA_DOMAIN = 'corvidae.cryptography.aes-256-gcm';

/** Why a cryptographic operation failed. */
export type CryptographyErrorCode =
  /** The stored value names a key id that is not in the keyring. */
  | 'secret-unavailable'
  /** Authentication failed: the ciphertext, iv, key id, or version was altered, or the key is wrong. */
  | 'authentication-failed'
  /** The stored value is not shaped like output of {@link encrypt}. */
  | 'malformed-secret'
  /** The stored value carries a version this module does not understand. */
  | 'unsupported-version'
  /** An encoded key is not a valid base64url 256-bit key, or cannot be exported. */
  | 'invalid-key'
  /** Text that cannot round-trip: a string with a lone surrogate, or decrypted bytes that are not UTF-8. */
  | 'invalid-text';

/** An error from this module. The message is fixed text and never contains key material or plaintext. */
export class CryptographyError extends Error {
  /** The category of failure, for programmatic handling. */
  readonly code: CryptographyErrorCode;
  /** For `secret-unavailable`, the key id that the keyring could not supply. Not secret. */
  readonly keyId: string | undefined;

  /** Creates an error with a fixed message for the given code. */
  constructor(code: CryptographyErrorCode, keyId?: string) {
    super(messages[code]);
    this.name = 'CryptographyError';
    this.code = code;
    this.keyId = keyId;
  }
}

const messages: Record<CryptographyErrorCode, string> = {
  'secret-unavailable': 'The key that encrypted this value is not available.',
  'authentication-failed': 'The encrypted value failed authentication.',
  'malformed-secret': 'The encrypted value is malformed.',
  'unsupported-version': 'The encrypted value uses an unsupported version.',
  'invalid-key': 'The encryption key is invalid.',
  'invalid-text': 'The decrypted value is not valid UTF-8 text.',
};

/** An AES-256-GCM key together with its derived id. Treat it as opaque; import or generate it. */
export type EncryptionKey = {
  /** Identifier derived from the key (see the module notes); safe to store and log. */
  readonly keyId: string;
  /** The Web Crypto key. Imported keys are non-extractable unless requested otherwise. */
  readonly cryptoKey: CryptoKey;
};

/** The current key plus retired keys, so values written before a rotation stay readable. */
export type Keyring = {
  /** Encrypts new values; also decrypts values that name its id. */
  readonly current: EncryptionKey;
  /** Former keys, decrypt-only. Order does not matter. */
  readonly retired?: readonly EncryptionKey[];
};

/** A stored encrypted value. All binary fields are base64url without padding. */
export type EncryptedValue = {
  /** Shape version; always `1` today. */
  readonly version: 1;
  /** The ciphertext followed by the 128-bit authentication tag. */
  readonly ciphertext: string;
  /** The 96-bit initialization vector, unique to this encryption. */
  readonly iv: string;
  /** Id of the key that encrypted the value. */
  readonly keyId: string;
};

/** Options for {@link importEncryptionKey}. */
export type ImportEncryptionKeyOptions = {
  /** Allow {@link exportEncryptionKey} on the result. Defaults to `false`. */
  readonly extractable?: boolean;
};

const textEncoder = new TextEncoder();

/** Base64url (RFC 4648 section 5) without padding. */
function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Strict decoder: rejects anything that is not the canonical encoding of some byte string. */
function decodeBase64Url(encoded: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]*$/.test(encoded)) return undefined;
  if (encoded.length % 4 === 1) return undefined;
  try {
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    // Reject non-canonical encodings (nonzero trailing bits) so one byte string has one encoding.
    return encodeBase64Url(bytes) === encoded ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

async function deriveKeyId(rawKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const domain = textEncoder.encode(KEY_ID_DOMAIN);
  const input = new Uint8Array(domain.length + rawKey.length);
  input.set(domain, 0);
  input.set(rawKey, domain.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  input.fill(0);
  return toHex(digest.slice(0, KEY_ID_BYTES));
}

async function importRawKey(
  rawKey: Uint8Array<ArrayBuffer>,
  extractable: boolean,
): Promise<EncryptionKey> {
  try {
    const keyId = await deriveKeyId(rawKey);
    const cryptoKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', extractable, [
      'encrypt',
      'decrypt',
    ]);
    return { keyId, cryptoKey };
  } catch {
    throw new CryptographyError('invalid-key');
  } finally {
    rawKey.fill(0);
  }
}

/**
 * Generates a new random AES-256 key. The result is extractable so the host can persist it with
 * {@link exportEncryptionKey}.
 */
export async function generateEncryptionKey(): Promise<EncryptionKey> {
  const rawKey = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(rawKey);
  return importRawKey(rawKey, true);
}

/**
 * Imports a key previously produced by {@link exportEncryptionKey}: base64url of exactly 32 bytes.
 * Throws `invalid-key` for anything else.
 */
export async function importEncryptionKey(
  encoded: string,
  options: ImportEncryptionKeyOptions = {},
): Promise<EncryptionKey> {
  const decoded = decodeBase64Url(encoded);
  if (decoded === undefined || decoded.length !== KEY_BYTES) {
    throw new CryptographyError('invalid-key');
  }
  const rawKey = new Uint8Array(KEY_BYTES);
  rawKey.set(decoded);
  decoded.fill(0);
  return importRawKey(rawKey, options.extractable === true);
}

/**
 * Exports a key as base64url of its 32 raw bytes, for storage as a secret. The result is key
 * material: never log it. Throws `invalid-key` when the key was imported without `extractable`.
 */
export async function exportEncryptionKey(key: EncryptionKey): Promise<string> {
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await crypto.subtle.exportKey('raw', key.cryptoKey));
  } catch {
    throw new CryptographyError('invalid-key');
  }
  const encoded = encodeBase64Url(raw);
  raw.fill(0);
  return encoded;
}

function additionalData(keyId: string): Uint8Array<ArrayBuffer> {
  // Fields are separated by NUL; a key id is lowercase hex and so cannot contain one.
  return textEncoder.encode(`${ADDITIONAL_DATA_DOMAIN}\0${STORED_VERSION}\0${keyId}`);
}

/**
 * Encrypts text (UTF-8) or bytes under `key` with a fresh random IV. The result is safe to persist
 * as JSON.
 */
export async function encrypt(
  plaintext: string | Uint8Array,
  key: EncryptionKey,
): Promise<EncryptedValue> {
  if (typeof plaintext !== 'string' && !(plaintext instanceof Uint8Array)) {
    throw new TypeError('encrypt expects a string or a Uint8Array.');
  }
  // Snapshot caller-owned inputs before the first await.
  const keyId = key.keyId;
  const cryptoKey = key.cryptoKey;
  if (typeof plaintext === 'string' && !plaintext.isWellFormed()) {
    // TextEncoder would silently replace a lone surrogate with U+FFFD and change the value.
    throw new CryptographyError('invalid-text');
  }
  const data = typeof plaintext === 'string' ? textEncoder.encode(plaintext) : plaintext;
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  let sealed: ArrayBuffer;
  try {
    sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(keyId), tagLength: TAG_BYTES * 8 },
      cryptoKey,
      new Uint8Array(data),
    );
  } catch {
    throw new CryptographyError('invalid-key');
  }
  return {
    version: STORED_VERSION,
    ciphertext: encodeBase64Url(new Uint8Array(sealed)),
    iv: encodeBase64Url(iv),
    keyId,
  };
}

/** Finds a key by id in the keyring. Linear scan: a keyring holds a handful of keys. */
function findKey(keyring: Keyring, keyId: string): EncryptionKey | undefined {
  if (keyring.current.keyId === keyId) return keyring.current;
  return keyring.retired?.find((candidate) => candidate.keyId === keyId);
}

/**
 * Decrypts a value written by {@link encrypt} to bytes, using whichever keyring entry its `keyId`
 * names. Throws a {@link CryptographyError}: `malformed-secret` or `unsupported-version` for a
 * misshapen value, `secret-unavailable` when the keyring lacks the key, `authentication-failed` when
 * any field was altered.
 */
export async function decryptBytes(value: EncryptedValue, keyring: Keyring): Promise<Uint8Array> {
  const candidate: unknown = value;
  if (typeof candidate !== 'object' || candidate === null) {
    throw new CryptographyError('malformed-secret');
  }
  const fields = candidate as Record<string, unknown>;
  const version = Object.hasOwn(fields, 'version') ? fields['version'] : undefined;
  if (version !== STORED_VERSION) {
    throw new CryptographyError(
      typeof version === 'number' ? 'unsupported-version' : 'malformed-secret',
    );
  }
  const keyId = Object.hasOwn(fields, 'keyId') ? fields['keyId'] : undefined;
  const iv = decodeBase64Url(Object.hasOwn(fields, 'iv') ? fields['iv'] : undefined);
  const sealed = decodeBase64Url(
    Object.hasOwn(fields, 'ciphertext') ? fields['ciphertext'] : undefined,
  );
  if (
    typeof keyId !== 'string' ||
    iv === undefined ||
    iv.length !== IV_BYTES ||
    sealed === undefined ||
    sealed.length < TAG_BYTES
  ) {
    throw new CryptographyError('malformed-secret');
  }
  const key = findKey(keyring, keyId);
  if (key === undefined) throw new CryptographyError('secret-unavailable', keyId);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(keyId), tagLength: TAG_BYTES * 8 },
      key.cryptoKey,
      sealed,
    );
    return new Uint8Array(plain);
  } catch {
    throw new CryptographyError('authentication-failed');
  }
}

/**
 * Like {@link decryptBytes}, then decodes the result as UTF-8, keeping a leading U+FEFF so the text
 * round-trips exactly; throws `invalid-text` if the bytes are not UTF-8.
 */
export async function decrypt(value: EncryptedValue, keyring: Keyring): Promise<string> {
  const bytes = await decryptBytes(value, keyring);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CryptographyError('invalid-text');
  }
}
