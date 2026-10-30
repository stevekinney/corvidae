/**
 * Where a saved tool source keeps what must not sit in `configuration.json` (COR-1930): the
 * values of the credentials its description names (a bearer token, an API key, an environment
 * secret for a local command), and an MCP source's OAuth state (tokens, client registration, the
 * PKCE verifier and `state` of a sign-in in progress, and discovery state).
 *
 * All of it is encrypted with `@lostgradient/cryptography`'s AES-GCM under the installation's
 * answer key (`answer-encryption.ts`, the key secret answers are sealed with), so a rotation
 * keeps earlier values readable and a remote host needs no second variable. It lives in one
 * Bungalow secret per source, `tool-source-<id>`, as JSON:
 *
 * ```json
 * { "version": 1, "sourceId": "tracker",
 *   "credentials": { "token": { "version": 1, "ciphertext": "…", "iv": "…", "keyId": "…" } },
 *   "oauth": { "version": 1, "ciphertext": "…", "iv": "…", "keyId": "…" } }
 * ```
 *
 * The names of the credentials are in the clear (the description names them too); every value, and
 * the whole of the OAuth state, is ciphertext. Each ciphertext opens to an envelope that names the
 * source (and the credential), and an envelope that names another is refused, so a record copied
 * from one secret to another reads as unavailable and does not authenticate as the other source.
 *
 * @module tool-source-vault
 */

import type { Bungalow } from '@lostgradient/bungalow';
import type { AnswerEncryptionKeys } from '@lostgradient/bureau';
import {
  CryptographyError,
  decrypt,
  encrypt,
  type EncryptedValue,
  type EncryptionKey,
} from '@lostgradient/cryptography';
import type { McpOAuthStorageState, McpOAuthTokenStorage } from 'armorer';

/** The prefix of the Bungalow secret that holds a source's credentials: `tool-source-<id>`. */
export const TOOL_SOURCE_SECRET_PREFIX = 'tool-source-';

/** The Bungalow secret that holds the credentials of the source `sourceId`. */
export function toolSourceSecretKey(sourceId: string): string {
  return `${TOOL_SOURCE_SECRET_PREFIX}${sourceId}`;
}

/** What a source keeps, decrypted. */
export type ToolSourceSecrets = {
  /** Credential name to value. */
  readonly credentials: ReadonlyMap<string, string>;
  /** The OAuth state of an MCP source, when a sign-in has recorded any. */
  readonly oauth: McpOAuthStorageState | undefined;
};

/** The secrets of a source that has none. */
export const NO_SECRETS: ToolSourceSecrets = Object.freeze({
  credentials: new Map<string, string>(),
  oauth: undefined,
});

/** A source's stored secret that cannot be read: damaged, for another source, or sealed under a key no longer held. */
export class ToolSourceSecretsUnreadableError extends Error {
  /** The source whose secret cannot be read. */
  readonly sourceId: string;

  constructor(sourceId: string) {
    super(
      `The stored credentials of tool source "${sourceId}" cannot be read. Connect the source again.`,
    );
    this.name = 'ToolSourceSecretsUnreadableError';
    this.sourceId = sourceId;
  }
}

/** A write the home does not allow: a remote home keeps its secrets in the deployment's environment. */
export class ToolSourceSecretsLockedError extends Error {
  constructor() {
    super(
      'This host runs on remote storage, where tool-source credentials belong to the deployment.',
    );
    this.name = 'ToolSourceSecretsLockedError';
  }
}

/** The stored form of a source's secrets. */
type StoredSecrets = {
  readonly version: 1;
  readonly sourceId: string;
  readonly credentials: Readonly<Record<string, EncryptedValue>>;
  readonly oauth?: EncryptedValue;
};

/** What {@link createToolSourceVault} reads. */
export type ToolSourceVaultOptions = {
  /** The open home. */
  readonly bungalow: Pick<Bungalow, 'mode' | 'readSecret' | 'writeSecret'>;
  /** The installation's answer keys: the current one encrypts, a retired one only decrypts. */
  readonly keys: AnswerEncryptionKeys;
};

/** The encrypted store of tool-source credentials and OAuth state. See the module comment. */
export type ToolSourceVault = {
  /** The names of the credentials a source holds, without decrypting anything. */
  credentialNames(sourceId: string): readonly string[];
  /** The raw stored text of a source's secret, or `undefined` when it has none, to put back after a failed change. */
  stored(sourceId: string): string | undefined;
  /** Put stored text back as it was read; `undefined` writes the empty value, which reads as no secret. */
  restore(sourceId: string, text: string | undefined): void;
  /** Decrypt everything a source holds. Throws {@link ToolSourceSecretsUnreadableError} when it cannot. */
  read(sourceId: string): Promise<ToolSourceSecrets>;
  /** Replace everything a source holds. A remote home throws {@link ToolSourceSecretsLockedError}. */
  write(sourceId: string, secrets: ToolSourceSecrets): Promise<void>;
  /** Remove everything a source holds. */
  clear(sourceId: string): void;
  /**
   * Run `work` after every earlier piece of work on this source has settled. A change reads, then
   * writes, so two that overlapped would each start from what the other is about to replace.
   */
  exclusive<Result>(sourceId: string, work: () => Promise<Result>): Promise<Result>;
  /** The OAuth storage Armorer's loader reads and writes a source's sign-in through. */
  tokenStorage(sourceId: string): McpOAuthTokenStorage;
};

/** Whether `value` has the fields of an encrypted value; `decrypt` checks their contents. */
function isEncryptedValue(value: unknown): value is EncryptedValue {
  return (
    isPlainObject(value) &&
    value['version'] === 1 &&
    typeof value['ciphertext'] === 'string' &&
    typeof value['iv'] === 'string' &&
    typeof value['keyId'] === 'string'
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Create the vault over `options.bungalow`'s secrets. */
export function createToolSourceVault(options: ToolSourceVaultOptions): ToolSourceVault {
  const { bungalow, keys } = options;
  const tails = new Map<string, Promise<unknown>>();

  const exclusive = async <Result>(
    sourceId: string,
    work: () => Promise<Result>,
  ): Promise<Result> => {
    const previous = tails.get(sourceId) ?? Promise.resolve();
    const turn = (async () => {
      await previous;
      return work();
    })();
    const tail = turn.then(
      () => undefined,
      () => undefined,
    );
    tails.set(sourceId, tail);
    try {
      return await turn;
    } finally {
      // Nothing waits on a settled tail, so the map does not grow with the sources a host has seen.
      if (tails.get(sourceId) === tail) tails.delete(sourceId);
    }
  };

  async function keyringFor(encrypted: EncryptedValue) {
    const keyId: unknown = (encrypted as { keyId?: unknown }).keyId;
    let retired: EncryptionKey | undefined;
    if (typeof keyId === 'string' && keyId !== keys.current.keyId && keys.retired !== undefined) {
      retired = await keys.retired(keyId);
    }
    return { current: keys.current, retired: retired === undefined ? [] : [retired] };
  }

  async function open(encrypted: unknown): Promise<unknown> {
    if (!isEncryptedValue(encrypted)) throw new CryptographyError('malformed-secret');
    const text = await decrypt(encrypted, await keyringFor(encrypted));
    return JSON.parse(text) as unknown;
  }

  function parseStored(
    sourceId: string,
    text: string,
  ): { credentials: Record<string, unknown>; oauth: unknown } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ToolSourceSecretsUnreadableError(sourceId);
    }
    if (
      !isPlainObject(parsed) ||
      parsed['version'] !== 1 ||
      parsed['sourceId'] !== sourceId ||
      !isPlainObject(parsed['credentials'])
    ) {
      throw new ToolSourceSecretsUnreadableError(sourceId);
    }
    return { credentials: parsed['credentials'], oauth: parsed['oauth'] };
  }

  const stored = (sourceId: string): string | undefined => {
    const text = bungalow.readSecret(toolSourceSecretKey(sourceId));
    // An empty value is how a secret is removed: Bungalow has no delete.
    return text === undefined || text === '' ? undefined : text;
  };

  async function read(sourceId: string): Promise<ToolSourceSecrets> {
    const text = stored(sourceId);
    if (text === undefined) return NO_SECRETS;
    const record = parseStored(sourceId, text);
    try {
      const credentials = new Map<string, string>();
      for (const [name, encrypted] of Object.entries(record.credentials)) {
        const envelope = await open(encrypted);
        if (
          !isPlainObject(envelope) ||
          envelope['sourceId'] !== sourceId ||
          envelope['credential'] !== name ||
          typeof envelope['value'] !== 'string'
        ) {
          throw new ToolSourceSecretsUnreadableError(sourceId);
        }
        credentials.set(name, envelope['value']);
      }
      let oauth: McpOAuthStorageState | undefined;
      if (record.oauth !== undefined) {
        const envelope = await open(record.oauth);
        if (
          !isPlainObject(envelope) ||
          envelope['sourceId'] !== sourceId ||
          !isPlainObject(envelope['oauth'])
        ) {
          throw new ToolSourceSecretsUnreadableError(sourceId);
        }
        oauth = envelope['oauth'];
      }
      return { credentials, oauth };
    } catch (error) {
      if (error instanceof ToolSourceSecretsUnreadableError) throw error;
      // A `CryptographyError` or a ciphertext that is not JSON. Neither message holds a value.
      if (error instanceof CryptographyError || error instanceof SyntaxError) {
        throw new ToolSourceSecretsUnreadableError(sourceId);
      }
      throw error;
    }
  }

  async function write(sourceId: string, secrets: ToolSourceSecrets): Promise<void> {
    if (bungalow.mode === 'remote') throw new ToolSourceSecretsLockedError();
    const credentials: Record<string, EncryptedValue> = {};
    for (const [name, value] of secrets.credentials) {
      credentials[name] = await encrypt(
        JSON.stringify({ sourceId, credential: name, value }),
        keys.current,
      );
    }
    const oauth =
      secrets.oauth === undefined || Object.keys(secrets.oauth).length === 0
        ? undefined
        : await encrypt(JSON.stringify({ sourceId, oauth: secrets.oauth }), keys.current);
    const record: StoredSecrets = {
      version: 1,
      sourceId,
      credentials,
      ...(oauth === undefined ? {} : { oauth }),
    };
    bungalow.writeSecret(toolSourceSecretKey(sourceId), JSON.stringify(record));
  }

  return {
    credentialNames(sourceId) {
      const text = stored(sourceId);
      if (text === undefined) return [];
      return Object.keys(parseStored(sourceId, text).credentials);
    },
    stored,
    restore(sourceId, text) {
      bungalow.writeSecret(toolSourceSecretKey(sourceId), text ?? '');
    },
    read,
    write,
    clear(sourceId) {
      if (bungalow.mode === 'remote') throw new ToolSourceSecretsLockedError();
      bungalow.writeSecret(toolSourceSecretKey(sourceId), '');
    },
    exclusive,
    tokenStorage(sourceId) {
      return {
        load: () => read(sourceId).then((secrets) => ({ ...secrets.oauth })),
        save: (patch) =>
          exclusive(sourceId, async () => {
            const current = await read(sourceId);
            await write(sourceId, {
              credentials: current.credentials,
              oauth: { ...current.oauth, ...patch },
            });
          }),
        clear: (names) =>
          exclusive(sourceId, async () => {
            const current = await read(sourceId);
            const next = { ...current.oauth };
            for (const name of names) delete next[name];
            await write(sourceId, { credentials: current.credentials, oauth: next });
          }),
      };
    },
  };
}
