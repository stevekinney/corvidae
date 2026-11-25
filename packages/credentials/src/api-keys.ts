import { storageConditionalBatch, type Storage } from '@lostgradient/storage';
import { digestApiKey, findConstantTimeDigestMatch } from './api-key-verification.ts';

export type ApiKeyMetadata = {
  id: string;
  label: string;
  workspaceId: string;
  subject: string;
  scopes: string[];
  expiresAt?: number;
  revokedAt?: number;
  retiresAt?: number;
};

type Record = ApiKeyMetadata & { verifier: string };
export type ApiKeyAuthority = { workspaceId: string; subject: string; scopes: readonly string[] };
export type ApiKeyManagementRequest = {
  action: 'issue' | 'list' | 'rotate' | 'revoke';
  workspaceId: string;
  subject: string;
  scopes: readonly string[];
};
export type ApiKeyOptions<Actor> = {
  storage: Storage;
  resolveAuthority: (identity: {
    workspaceId: string;
    subject: string;
  }) => Promise<ApiKeyAuthority | null>;
  authorizeManagement: (actor: Actor, request: ApiKeyManagementRequest) => Promise<boolean>;
  now?: () => number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = (value: unknown) => encoder.encode(JSON.stringify(value));
const digest = async (secret: string) =>
  Array.from(await digestApiKey(secret), (byte) => byte.toString(16).padStart(2, '0')).join('');
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
const recordKey = (id: string) => `api-keys:record:${id}`;
const indexKey = (workspaceId: string, subject: string, id: string) =>
  `api-keys:index:${encodeURIComponent(workspaceId)}:${encodeURIComponent(subject)}:${id}`;
const metadata = ({ verifier: _verifier, ...value }: Record): ApiKeyMetadata => value;

/** A durable key service. All policy decisions are made by the host. */
export function createApiKeys<Actor>(options: ApiKeyOptions<Actor>) {
  const { storage, resolveAuthority, authorizeManagement } = options;
  const now = options.now ?? Date.now;
  if (
    !storage.capabilities().conditionalBatch ||
    !storage.capabilities().atomicBatch ||
    !storage.conditionalBatch
  )
    throw new TypeError('Atomic conditional storage is required');

  async function authorize(
    actor: Actor,
    action: ApiKeyManagementRequest['action'],
    target: { workspaceId: string; subject: string; scopes: readonly string[] },
  ) {
    const { workspaceId, subject, scopes } = target;
    if (!(await authorizeManagement(actor, { action, workspaceId, subject, scopes: [...scopes] })))
      throw new Error('Forbidden');
  }
  async function read(id: string) {
    const raw = await storage.get(recordKey(id));
    return raw ? { raw, record: JSON.parse(decoder.decode(raw)) as Record } : null;
  }
  async function mint(target: Omit<ApiKeyMetadata, 'id'>) {
    const id = random();
    const secret = `lgk_${id}_${random()}`;
    return { secret, record: { ...target, id, verifier: await digest(secret) } };
  }
  async function issue(
    actor: Actor,
    target: Omit<ApiKeyMetadata, 'id' | 'revokedAt' | 'retiresAt'>,
  ) {
    const input = {
      label: target.label,
      workspaceId: target.workspaceId,
      subject: target.subject,
      scopes: [...target.scopes],
      ...(target.expiresAt === undefined ? {} : { expiresAt: target.expiresAt }),
    };
    if (
      !input.workspaceId ||
      !input.subject ||
      !input.label ||
      input.scopes.some((scope) => typeof scope !== 'string' || scope.length === 0) ||
      (input.expiresAt !== undefined &&
        (!Number.isFinite(input.expiresAt) || input.expiresAt <= now()))
    )
      throw new TypeError('Invalid credential');
    await authorize(actor, 'issue', input);
    const authority = await resolveAuthority({
      workspaceId: input.workspaceId,
      subject: input.subject,
    });
    if (
      !authority ||
      authority.workspaceId !== input.workspaceId ||
      authority.subject !== input.subject ||
      input.scopes.some((scope) => !authority.scopes.includes(scope))
    )
      throw new Error('Forbidden');
    const { secret, record } = await mint(input);
    const key = recordKey(record.id);
    if (
      !(await storageConditionalBatch(
        storage,
        [{ key, expectedValue: null }],
        [
          { type: 'put', key, value: encode(record) },
          {
            type: 'put',
            key: indexKey(record.workspaceId, record.subject, record.id),
            value: encode(record.id),
          },
        ],
      ))
    )
      throw new Error('Credential collision');
    return { ...metadata(record), secret };
  }
  async function list(actor: Actor, target: { workspaceId: string; subject: string }) {
    target = { ...target };
    await authorize(actor, 'list', { ...target, scopes: [] });
    const prefix = indexKey(target.workspaceId, target.subject, '');
    const result: ApiKeyMetadata[] = [];
    for await (const [key] of storage.scan(prefix)) {
      const found = await read(key.slice(prefix.length));
      if (found) result.push(metadata(found.record));
    }
    return result;
  }
  async function rotate(
    actor: Actor,
    target: { workspaceId: string; subject: string; id: string; retiresAt: number },
  ) {
    target = { ...target };
    await authorize(actor, 'rotate', { ...target, scopes: [] });
    const found = await read(target.id);
    if (
      !found ||
      found.record.workspaceId !== target.workspaceId ||
      found.record.subject !== target.subject ||
      found.record.revokedAt !== undefined ||
      found.record.retiresAt !== undefined ||
      (found.record.expiresAt !== undefined && now() >= found.record.expiresAt) ||
      !Number.isFinite(target.retiresAt) ||
      target.retiresAt <= now()
    )
      throw new Error('Credential unavailable');
    await authorize(actor, 'rotate', found.record);
    const authority = await resolveAuthority({
      workspaceId: found.record.workspaceId,
      subject: found.record.subject,
    });
    if (
      !authority ||
      authority.workspaceId !== target.workspaceId ||
      authority.subject !== target.subject ||
      found.record.scopes.some((scope) => !authority.scopes.includes(scope))
    )
      throw new Error('Forbidden');
    const { id: _id, verifier: _verifier, ...details } = found.record;
    const { secret, record } = await mint(details);
    const key = recordKey(target.id);
    const replacementKey = recordKey(record.id);
    const applied = await storageConditionalBatch(
      storage,
      [
        { key, expectedValue: found.raw },
        { key: replacementKey, expectedValue: null },
      ],
      [
        { type: 'put', key, value: encode({ ...found.record, retiresAt: target.retiresAt }) },
        { type: 'put', key: replacementKey, value: encode(record) },
        {
          type: 'put',
          key: indexKey(record.workspaceId, record.subject, record.id),
          value: encode(record.id),
        },
      ],
    );
    if (!applied) throw new Error('Credential changed');
    return { ...metadata(record), secret };
  }
  async function revoke(
    actor: Actor,
    target: { workspaceId: string; subject: string; id: string },
  ) {
    target = { ...target };
    await authorize(actor, 'revoke', { ...target, scopes: [] });
    const found = await read(target.id);
    if (
      !found ||
      found.record.workspaceId !== target.workspaceId ||
      found.record.subject !== target.subject
    )
      throw new Error('Credential unavailable');
    if (found.record.revokedAt !== undefined) return;
    if (
      !(await storageConditionalBatch(
        storage,
        [{ key: recordKey(target.id), expectedValue: found.raw }],
        [
          {
            type: 'put',
            key: recordKey(target.id),
            value: encode({ ...found.record, revokedAt: now() }),
          },
        ],
      ))
    )
      throw new Error('Credential changed');
  }
  async function verify(secret: string): Promise<(ApiKeyAuthority & { id: string }) | null> {
    const match = /^lgk_([0-9a-f]{64})_[0-9a-f]{64}$/.exec(secret);
    if (!match) return null;
    const found = await read(match[1]!);
    if (
      !found ||
      found.record.revokedAt !== undefined ||
      (found.record.expiresAt !== undefined && now() >= found.record.expiresAt) ||
      (found.record.retiresAt !== undefined && now() >= found.record.retiresAt)
    )
      return null;
    const verifier = Uint8Array.from(found.record.verifier.match(/.{2}/g) ?? [], (byte) =>
      Number.parseInt(byte, 16),
    );
    if (
      !findConstantTimeDigestMatch(await digestApiKey(secret), [{ digest: verifier, value: true }])
    )
      return null;
    const authority = await resolveAuthority({
      workspaceId: found.record.workspaceId,
      subject: found.record.subject,
    });
    if (
      !authority ||
      authority.workspaceId !== found.record.workspaceId ||
      authority.subject !== found.record.subject
    )
      return null;
    return {
      id: found.record.id,
      workspaceId: authority.workspaceId,
      subject: authority.subject,
      scopes: found.record.scopes.filter((scope) => authority.scopes.includes(scope)),
    };
  }
  function withSession<Session>(
    authenticateSession: (request: Request) => Promise<Session | Response>,
  ) {
    return async (
      request: Request,
    ): Promise<Session | (ApiKeyAuthority & { id: string }) | Response> => {
      if (request.headers.has('x-api-key')) {
        if (request.headers.has('authorization'))
          return new Response('Unauthorized', { status: 401 });
        return (
          (await verify(request.headers.get('x-api-key') ?? '')) ??
          new Response('Unauthorized', { status: 401 })
        );
      }
      if (request.headers.has('authorization'))
        return new Response('Unauthorized', { status: 401 });
      return authenticateSession(request);
    };
  }
  return { issue, list, rotate, revoke, verify, withSession };
}
