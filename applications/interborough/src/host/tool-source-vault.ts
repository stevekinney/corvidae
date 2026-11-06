import { createHash } from 'node:crypto';
import { parseDocument } from './providers.ts';
import { secretPublicationDigest } from './secret-publication-digest.ts';
import {
  parseToolSourceOAuthBinding,
  parseToolSourceOAuthClaim,
  parseToolSourceSignIn,
  type ToolSourceOAuthBinding,
  type ToolSourceOAuthClaim,
  type ToolSourceSignIn,
} from './tool-source-oauth-session.ts';
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
 * the whole of the OAuth state, is ciphertext. The sealed OAuth state also carries `signIn`, when a
 * sign-in the host started is waiting: when it started and a digest of the description it started
 * for, so a callback is refused once it is stale or the source has changed. Each ciphertext opens to an envelope that names the
 * source (and the credential), and an envelope that names another is refused, so a record copied
 * from one secret to another reads as unavailable and does not authenticate as the other source.
 *
 * @module tool-source-vault
 */

import { type ConfigurationSnapshot } from '@lostgradient/bungalow';
import type { AnswerEncryptionKeys } from '@lostgradient/bureau';
import {
  CryptographyError,
  decrypt,
  encrypt,
  type EncryptedValue,
  type EncryptionKey,
} from '@lostgradient/cryptography';
import type { McpOAuthStorageState, McpOAuthTokenStorage } from 'armorer';
import {
  createWorkspaceSecrets,
  SecretPublicationError,
  type SecretHome,
  type SecretPublicationResult,
  type WorkspaceSecrets,
} from './workspace-secrets.ts';

/** The prefix of the Bungalow secret that holds a source's credentials: `tool-source-<id>`. */
export const TOOL_SOURCE_SECRET_PREFIX = 'tool-source-';

/** The Bungalow secret that holds the credentials of the source `sourceId`. */
export function toolSourceSecretKey(sourceId: string): string {
  return `${TOOL_SOURCE_SECRET_PREFIX}${sourceId}`;
}

/** What a source keeps, decrypted. */
export type ToolSourceSecrets = {
  /** Encrypted initiating authority and sign-in generation, retained after callback cleanup. */
  readonly oauthBinding?: ToolSourceOAuthBinding | undefined;
  /** Encrypted token-exchange receipt; uncertain claims never authorize replay. */
  readonly oauthClaim?: ToolSourceOAuthClaim | undefined;
  /** Encrypted version marker for read-back of this session's last conditional write. */
  readonly oauthWriteId?: string | undefined;
  /** Configuration fence observed with these credentials, carried through read-modify-write. */
  readonly snapshot?: ConfigurationSnapshot | undefined;
  /** Credential name to value. */
  readonly credentials: ReadonlyMap<string, string>;
  /** The OAuth state of an MCP source, when a sign-in has recorded any. */
  readonly oauth: McpOAuthStorageState | undefined;
  /** The sign-in that is waiting, when the host started one. It is kept only beside OAuth state. */
  readonly signIn?: ToolSourceSignIn | undefined;
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

/** A write the secret provider or configuration backend does not support. */
export class ToolSourceSecretsLockedError extends Error {
  constructor() {
    super('The configured backends do not support tool-source credential publication.');
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
  /** Shared host recovery service. */
  readonly workspaceSecrets?: WorkspaceSecrets;
  /** The open home. */
  readonly bungalow: SecretHome;
  /** The installation's answer keys: the current one encrypts, a retired one only decrypts. */
  readonly keys: AnswerEncryptionKeys;
};

/**
 * Who holds the source's turn ({@link ToolSourceVault.exclusive}) when OAuth storage is used. A
 * `caller` that already holds it passes `held`, since a turn is not re-entrant.
 */
export type TokenStorageTurn = 'take' | 'held';

/** Answers, under the source's turn, whether the caller's sign-in still belongs to the source. */
export type TokenStorageFence = (snapshot?: ConfigurationSnapshot) => Promise<boolean>;

/** The encrypted store of tool-source credentials and OAuth state. See the module comment. */
export type ToolSourceVault = {
  /** The names of the credentials a source holds, without decrypting anything. */
  credentialNames(sourceId: string): Promise<readonly string[]>;
  /** Decrypt everything a source holds. Throws {@link ToolSourceSecretsUnreadableError} when it cannot. */
  read(sourceId: string, snapshot?: ConfigurationSnapshot): Promise<ToolSourceSecrets>;
  /** Publish a complete encrypted version. Read-only backends throw {@link ToolSourceSecretsLockedError}. */
  write(
    sourceId: string,
    secrets: ToolSourceSecrets,
    publication?: ConfigurationSnapshot,
    authorize?: () => Promise<void>,
    receipt?: { readonly operationId: string; readonly requestDigest: string },
  ): Promise<SecretPublicationResult>;
  /** Remove everything a source holds. */
  clear(
    sourceId: string,
    publication?: ConfigurationSnapshot,
    authorize?: () => Promise<void>,
    receipt?: { readonly operationId: string; readonly requestDigest: string },
  ): Promise<SecretPublicationResult>;
  /**
   * Record that a sign-in has started, once the loader has recorded its `state`. Resolves `false`,
   * recording nothing, when the source holds no `state` to attach it to.
   */
  beginSignIn(
    sourceId: string,
    signIn: ToolSourceSignIn,
    fence?: TokenStorageFence,
  ): Promise<boolean>;
  /**
   * Run `work` after every earlier piece of work on this source has settled. A change reads, then
   * writes, so two that overlapped would each start from what the other is about to replace.
   */
  exclusive<Result>(sourceId: string, work: () => Promise<Result>): Promise<Result>;
  /**
   * The OAuth storage Armorer's loader reads and writes a source's sign-in through. Each save or
   * clear takes the source's turn, unless the caller already holds it and says so with `held`.
   * Recording a new `state` voids the sign-in recorded before it, and so does clearing `state`.
   * With a `fence`, every read, save and clear first asks it, under the source's turn, whether the
   * caller still owns the source's sign-in; one that does not reads nothing and writes nothing, so
   * a sign-in begun for a source that was since removed or replaced can never store into, or erase
   * from, the secret of whatever holds that id now.
   */
  tokenStorage(
    sourceId: string,
    turn?: TokenStorageTurn,
    fence?: TokenStorageFence,
  ): McpOAuthTokenStorage;
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
  const workspaceSecrets = options.workspaceSecrets ?? createWorkspaceSecrets(bungalow);
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

  const stored = async (
    sourceId: string,
    snapshot?: ConfigurationSnapshot,
  ): Promise<string | undefined> => {
    const text = await workspaceSecrets.read(toolSourceSecretKey(sourceId), snapshot);
    // An empty value is how a secret is removed: Bungalow has no delete.
    return text === undefined || text === '' ? undefined : text;
  };

  async function read(
    sourceId: string,
    observed?: ConfigurationSnapshot,
  ): Promise<ToolSourceSecrets> {
    const snapshot = observed ?? (await bungalow.readConfiguration());
    const text = await stored(sourceId, snapshot);
    if (text === undefined) return { ...NO_SECRETS, snapshot };
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
      let signIn: ToolSourceSignIn | undefined;
      let oauthBinding: ToolSourceOAuthBinding | undefined;
      let oauthClaim: ToolSourceOAuthClaim | undefined;
      let oauthWriteId: string | undefined;
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
        signIn = parseToolSourceSignIn(envelope['signIn']);
        try {
          oauthBinding = parseToolSourceOAuthBinding(envelope['binding']);
          oauthClaim = parseToolSourceOAuthClaim(envelope['claim']);
          if (envelope['writeId'] !== undefined && typeof envelope['writeId'] !== 'string')
            throw new Error('Invalid write marker');
          oauthWriteId = envelope['writeId'];
        } catch {
          throw new ToolSourceSecretsUnreadableError(sourceId);
        }
      }
      return { credentials, oauth, signIn, snapshot, oauthBinding, oauthClaim, oauthWriteId };
    } catch (error) {
      if (error instanceof ToolSourceSecretsUnreadableError) throw error;
      // A `CryptographyError` or a ciphertext that is not JSON. Neither message holds a value.
      if (error instanceof CryptographyError || error instanceof SyntaxError) {
        throw new ToolSourceSecretsUnreadableError(sourceId);
      }
      throw error;
    }
  }

  async function write(
    sourceId: string,
    input: ToolSourceSecrets,
    publication?: ConfigurationSnapshot,
    authorize?: () => Promise<void>,
    receipt?: { readonly operationId: string; readonly requestDigest: string },
  ): Promise<SecretPublicationResult> {
    const secrets = structuredClone(input);
    const publicationReceipt = receipt === undefined ? undefined : { ...receipt };
    const publicationSnapshot = publication === undefined ? undefined : { ...publication };
    if (!workspaceSecrets.writable) throw new ToolSourceSecretsLockedError();
    const snapshot =
      publicationSnapshot ?? secrets.snapshot ?? (await bungalow.readConfiguration());
    const document = parseDocument(snapshot.text, bungalow.configurationLocation);
    const requestDigest = secretPublicationDigest({
      operation: 'tool-source-vault',
      target: sourceId,
      expectedRevision: snapshot.revision,
      payload: {
        document,
        credentials: Object.fromEntries(secrets.credentials),
        oauth: secrets.oauth,
        signIn: secrets.signIn,
        oauthBinding: secrets.oauthBinding,
        oauthClaim: secrets.oauthClaim,
      },
    });
    const credentials: Record<string, EncryptedValue> = {};
    for (const [name, value] of secrets.credentials) {
      credentials[name] = await encrypt(
        JSON.stringify({ sourceId, credential: name, value }),
        keys.current,
      );
    }
    const oauth =
      secrets.oauth === undefined &&
      secrets.oauthBinding === undefined &&
      secrets.oauthClaim === undefined
        ? undefined
        : await encrypt(
            JSON.stringify({
              sourceId,
              oauth: secrets.oauth ?? {},
              binding: secrets.oauthBinding,
              claim: secrets.oauthClaim,
              writeId: secrets.oauthWriteId,
              ...(secrets.signIn === undefined ? {} : { signIn: secrets.signIn }),
            }),
            keys.current,
          );
    const record: StoredSecrets = {
      version: 1,
      sourceId,
      credentials,
      ...(oauth === undefined ? {} : { oauth }),
    };
    const result = await workspaceSecrets.publish({
      operationId:
        publicationReceipt?.operationId ??
        createHash('sha256')
          .update(
            JSON.stringify([
              'tool-source-vault',
              bungalow.workspaceId,
              sourceId,
              snapshot.revision,
            ]),
          )
          .digest('hex'),
      requestDigest: publicationReceipt?.requestDigest ?? requestDigest,
      ...(authorize === undefined ? {} : { authorize }),
      key: toolSourceSecretKey(sourceId),
      value: JSON.stringify(record),
      document: parseDocument(snapshot.text, bungalow.configurationLocation),
      expectedRevision: snapshot.revision,
    });
    if (result.outcome !== 'committed') {
      throw new SecretPublicationError(result.outcome);
    }
    return result;
  }

  return {
    async credentialNames(sourceId) {
      const text = await stored(sourceId);
      if (text === undefined) return [];
      return Object.keys(parseStored(sourceId, text).credentials);
    },
    read,
    write,
    clear: (sourceId, publication, authorize, receipt) =>
      write(sourceId, NO_SECRETS, publication, authorize, receipt),
    exclusive,
    beginSignIn: (sourceId, signIn, fence) =>
      exclusive(sourceId, async () => {
        const snapshot = await bungalow.readConfiguration();
        if (fence !== undefined && !(await fence(snapshot))) return false;
        const current = await read(sourceId, snapshot);
        if (current.oauth?.state === undefined) return false;
        await write(sourceId, { ...current, signIn });
        return true;
      }),
    tokenStorage(sourceId, turn = 'take', fence) {
      const run = <Result>(work: () => Promise<Result>): Promise<Result> =>
        turn === 'held' ? work() : exclusive(sourceId, work);
      const fenced = async (
        work: (snapshot: ConfigurationSnapshot) => Promise<void>,
      ): Promise<void> => {
        const snapshot = await bungalow.readConfiguration();
        if (fence === undefined || (await fence(snapshot))) await work(snapshot);
      };
      return {
        load: () =>
          fence === undefined
            ? read(sourceId).then((secrets) => ({ ...secrets.oauth }))
            : run(async () => {
                const snapshot = await bungalow.readConfiguration();
                if (!(await fence(snapshot))) return {};
                const secrets = await read(sourceId, snapshot);
                return { ...secrets.oauth };
              }),
        save: (patch) =>
          run(() =>
            fenced(async (snapshot) => {
              const current = await read(sourceId, snapshot);
              // A new `state` is a new sign-in: the one recorded for the old state is not this one's.
              const startsNew = patch.state !== undefined && patch.state !== current.oauth?.state;
              await write(sourceId, {
                ...current,
                oauth: { ...current.oauth, ...patch },
                signIn: startsNew ? undefined : current.signIn,
              });
            }),
          ),
        clear: (names) =>
          run(() =>
            fenced(async (snapshot) => {
              const current = await read(sourceId, snapshot);
              const next = { ...current.oauth };
              for (const name of names) delete next[name];
              await write(sourceId, {
                ...current,
                oauth: next,
                signIn: names.includes('state') ? undefined : current.signIn,
              });
            }),
          ),
      };
    },
  };
}
