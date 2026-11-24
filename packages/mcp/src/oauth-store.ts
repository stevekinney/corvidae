import { storageConditionalBatch, type Storage } from '@lostgradient/storage';
import { createHash, timingSafeEqual } from 'node:crypto';

type Consent = {
  issuer: string;
  client: string;
  redirect: string;
  csrf: string;
  binding: string;
  subject: string;
  challenge: string;
  expiresAt: number;
  tenant: string;
  resource: string;
  scopes: string[];
  state: string;
};
type ConsentBinding = Pick<Consent, 'issuer' | 'client' | 'csrf' | 'binding' | 'subject'>;
type Approval = {
  grantId: string;
  code: string;
  tenant: string;
  subject: string;
  resource: string;
  scopes: string[];
};
type Grant = Omit<Approval, 'code'> & { issuer: string; client: string; active: boolean };
type Code = {
  grantId: string;
  client: string;
  redirect: string;
  challenge: string;
  expiresAt: number;
};
type Exchange = {
  issuer: string;
  code: string;
  client: string;
  redirect: string;
  resource: string;
  verifier: string;
  access: string;
  refresh: string | null;
  accessExpiresAt: number;
  refreshExpiresAt: number;
};
type Credential = {
  grantId: string;
  expiresAt: number;
  scopes: string[];
  spent: boolean;
  accessKey: string;
};
type Rotation = {
  issuer: string;
  refresh: string;
  client: string;
  resource: string;
  access: string;
  nextRefresh: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  scopes: string[];
};
export type OAuthClient = {
  issuer: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  authentication: 'none' | 'client_secret_post';
  secretHash: string | null;
  secretExpiresAt: number | null;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = (value: unknown) => encoder.encode(JSON.stringify(value));
const key = (kind: string, value: string) =>
  `oauth:${kind}:${createHash('sha256').update(value).digest('hex')}`;
const equal = (left: string, right: string) => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

export class OAuthStore {
  constructor(private readonly storage: Storage) {
    const capabilities = storage.capabilities();
    if (
      capabilities.readAfterWrite !== 'linearizable' ||
      !capabilities.conditionalBatch ||
      typeof storage.conditionalBatch !== 'function'
    ) {
      throw new Error('OAuth storage requires linearizable reads and conditional batches');
    }
  }

  async registerClient(client: OAuthClient): Promise<boolean> {
    const clientKey = key('client', client.clientId);
    return storageConditionalBatch(
      this.storage,
      [{ key: clientKey, expectedValue: null }],
      [{ type: 'put', key: clientKey, value: encode(client) }],
    );
  }

  async getClient(id: string): Promise<OAuthClient | null> {
    const value = await this.storage.get(key('client', id));
    return value ? (JSON.parse(decoder.decode(value)) as OAuthClient) : null;
  }

  async createConsent(id: string, consent: Consent): Promise<boolean> {
    const consentKey = key('consent', id);
    return storageConditionalBatch(
      this.storage,
      [{ key: consentKey, expectedValue: null }],
      [
        {
          type: 'put',
          key: consentKey,
          value: encode({
            ...consent,
            csrf: key('csrf', consent.csrf),
            binding: key('binding', consent.binding),
          }),
        },
      ],
    );
  }

  async getConsent(id: string, binding: ConsentBinding): Promise<Consent | null> {
    const value = await this.storage.get(key('consent', id));
    if (!value) return null;
    const consent = JSON.parse(decoder.decode(value)) as Consent;
    return this.matchesConsent(consent, binding) ? consent : null;
  }

  async denyConsent(id: string, binding: ConsentBinding): Promise<boolean> {
    binding = { ...binding };
    const consentKey = key('consent', id);
    const value = await this.storage.get(consentKey);
    if (!value || !this.matchesConsent(JSON.parse(decoder.decode(value)) as Consent, binding))
      return false;
    return storageConditionalBatch(
      this.storage,
      [{ key: consentKey, expectedValue: value }],
      [{ type: 'delete', key: consentKey }],
    );
  }

  private matchesConsent(consent: Consent, binding: ConsentBinding): boolean {
    return (
      consent.expiresAt > Date.now() &&
      consent.issuer === binding.issuer &&
      consent.client === binding.client &&
      consent.subject === binding.subject &&
      equal(consent.binding, key('binding', binding.binding)) &&
      equal(consent.csrf, key('csrf', binding.csrf))
    );
  }

  async approveConsent(id: string, binding: ConsentBinding, approval: Approval): Promise<boolean> {
    binding = { ...binding };
    approval = { ...approval, scopes: [...approval.scopes] };
    const consentKey = key('consent', id);
    const value = await this.storage.get(consentKey);
    if (!value) return false;
    const consent = JSON.parse(decoder.decode(value)) as Consent;
    if (
      !this.matchesConsent(consent, binding) ||
      approval.subject !== consent.subject ||
      approval.tenant !== consent.tenant ||
      approval.resource !== consent.resource ||
      approval.scopes.length !== consent.scopes.length ||
      approval.scopes.some((scope, index) => scope !== consent.scopes[index])
    )
      return false;
    const grantKey = key('grant', approval.grantId);
    const codeKey = key('code', approval.code);
    const { code: _code, ...authority } = approval;
    const grant: Grant = {
      ...authority,
      issuer: consent.issuer,
      client: binding.client,
      active: true,
    };
    const code: Code = {
      grantId: approval.grantId,
      client: binding.client,
      redirect: consent.redirect,
      challenge: consent.challenge,
      expiresAt: consent.expiresAt,
    };
    return storageConditionalBatch(
      this.storage,
      [
        { key: consentKey, expectedValue: value },
        { key: grantKey, expectedValue: null },
        { key: codeKey, expectedValue: null },
      ],
      [
        { type: 'delete', key: consentKey },
        { type: 'put', key: grantKey, value: encode(grant) },
        { type: 'put', key: codeKey, value: encode(code) },
      ],
    );
  }

  async getGrant(id: string): Promise<Grant | null> {
    const value = await this.storage.get(key('grant', id));
    return value ? (JSON.parse(decoder.decode(value)) as Grant) : null;
  }

  async getCode(id: string): Promise<Code | null> {
    const value = await this.storage.get(key('code', id));
    return value ? (JSON.parse(decoder.decode(value)) as Code) : null;
  }

  async exchange(input: Exchange): Promise<boolean> {
    input = { ...input };
    const codeKey = key('code', input.code);
    const codeBytes = await this.storage.get(codeKey);
    if (!codeBytes) return false;
    const code = JSON.parse(decoder.decode(codeBytes)) as Code;
    if (
      code.client !== input.client ||
      code.redirect !== input.redirect ||
      code.expiresAt <= Date.now() ||
      !Number.isFinite(input.accessExpiresAt) ||
      input.accessExpiresAt <= Date.now() ||
      (input.refresh !== null &&
        (!Number.isFinite(input.refreshExpiresAt) || input.refreshExpiresAt <= Date.now())) ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) ||
      !equal(createHash('sha256').update(input.verifier).digest('base64url'), code.challenge)
    )
      return false;
    const grantKey = key('grant', code.grantId);
    const grantBytes = await this.storage.get(grantKey);
    if (!grantBytes) return false;
    const grant = JSON.parse(decoder.decode(grantBytes)) as Grant;
    if (!grant.active || grant.issuer !== input.issuer || grant.resource !== input.resource)
      return false;
    const accessKey = key('access', input.access);
    const refreshKey = input.refresh === null ? null : key('refresh', input.refresh);
    const credential: Credential = {
      grantId: code.grantId,
      expiresAt: input.accessExpiresAt,
      scopes: grant.scopes,
      spent: false,
      accessKey,
    };
    return storageConditionalBatch(
      this.storage,
      [
        { key: codeKey, expectedValue: codeBytes },
        { key: grantKey, expectedValue: grantBytes },
        { key: accessKey, expectedValue: null },
        ...(refreshKey ? [{ key: refreshKey, expectedValue: null }] : []),
      ],
      [
        { type: 'delete', key: codeKey },
        { type: 'put', key: accessKey, value: encode(credential) },
        ...(refreshKey
          ? [
              {
                type: 'put' as const,
                key: refreshKey,
                value: encode({ ...credential, expiresAt: input.refreshExpiresAt }),
              },
            ]
          : []),
      ],
    );
  }

  async getAccess(token: string): Promise<(Grant & { expiresAt: number }) | null> {
    const bytes = await this.storage.get(key('access', token));
    if (!bytes) return null;
    const credential = JSON.parse(decoder.decode(bytes)) as Credential;
    const grant = await this.getGrant(credential.grantId);
    if (!grant?.active || credential.expiresAt <= Date.now()) return null;
    return { ...grant, scopes: credential.scopes, expiresAt: credential.expiresAt };
  }

  async getRefreshGrant(token: string): Promise<Grant | null> {
    const bytes = await this.storage.get(key('refresh', token));
    if (!bytes) return null;
    const credential = JSON.parse(decoder.decode(bytes)) as Credential;
    const grant = await this.getGrant(credential.grantId);
    return grant ? { ...grant, scopes: credential.scopes } : null;
  }

  async revokeToken(token: string, issuer: string, client: string): Promise<void> {
    for (const kind of ['access', 'refresh']) {
      const bytes = await this.storage.get(key(kind, token));
      if (!bytes) continue;
      const credential = JSON.parse(decoder.decode(bytes)) as Credential;
      const grant = await this.getGrant(credential.grantId);
      if (grant?.issuer === issuer && grant.client === client)
        await this.revokeGrant(credential.grantId);
      return;
    }
  }

  async revokeGrant(id: string): Promise<boolean> {
    const grantKey = key('grant', id);
    for (;;) {
      const value = await this.storage.get(grantKey);
      if (!value) return false;
      const grant = JSON.parse(decoder.decode(value)) as Grant;
      if (!grant.active) return false;
      if (
        await storageConditionalBatch(
          this.storage,
          [{ key: grantKey, expectedValue: value }],
          [{ type: 'put', key: grantKey, value: encode({ ...grant, active: false }) }],
        )
      )
        return true;
    }
  }

  async rotate(
    input: Rotation,
  ): Promise<'rotated' | 'invalid' | 'replay_revoked' | 'scope_rejected'> {
    input = { ...input, scopes: [...input.scopes] };
    const refreshKey = key('refresh', input.refresh);
    for (;;) {
      const refreshBytes = await this.storage.get(refreshKey);
      if (!refreshBytes) return 'invalid';
      const prior = JSON.parse(decoder.decode(refreshBytes)) as Credential;
      const grantKey = key('grant', prior.grantId);
      const grantBytes = await this.storage.get(grantKey);
      if (!grantBytes) return 'invalid';
      const grant = JSON.parse(decoder.decode(grantBytes)) as Grant;
      if (
        !grant.active ||
        grant.issuer !== input.issuer ||
        grant.client !== input.client ||
        grant.resource !== input.resource
      )
        return 'invalid';
      if (prior.spent) {
        if (
          await storageConditionalBatch(
            this.storage,
            [
              { key: refreshKey, expectedValue: refreshBytes },
              { key: grantKey, expectedValue: grantBytes },
            ],
            [{ type: 'put', key: grantKey, value: encode({ ...grant, active: false }) }],
          )
        )
          return 'replay_revoked';
        continue;
      }
      if (
        prior.expiresAt <= Date.now() ||
        !Number.isFinite(input.accessExpiresAt) ||
        input.accessExpiresAt <= Date.now() ||
        !Number.isFinite(input.refreshExpiresAt) ||
        input.refreshExpiresAt <= Date.now()
      )
        return 'invalid';
      if (
        input.scopes.some((scope) => !prior.scopes.includes(scope) || !grant.scopes.includes(scope))
      )
        return 'scope_rejected';
      const accessKey = key('access', input.access);
      const nextRefreshKey = key('refresh', input.nextRefresh);
      const next: Credential = {
        grantId: prior.grantId,
        expiresAt: input.accessExpiresAt,
        scopes: [...input.scopes],
        spent: false,
        accessKey,
      };
      if (
        await storageConditionalBatch(
          this.storage,
          [
            { key: refreshKey, expectedValue: refreshBytes },
            { key: grantKey, expectedValue: grantBytes },
            { key: accessKey, expectedValue: null },
            { key: nextRefreshKey, expectedValue: null },
          ],
          [
            { type: 'put', key: refreshKey, value: encode({ ...prior, spent: true }) },
            { type: 'delete', key: prior.accessKey },
            { type: 'put', key: accessKey, value: encode(next) },
            {
              type: 'put',
              key: nextRefreshKey,
              value: encode({ ...next, expiresAt: input.refreshExpiresAt }),
            },
          ],
        )
      )
        return 'rotated';
      const current = await this.storage.get(refreshKey);
      if (current && decoder.decode(current) === decoder.decode(refreshBytes)) return 'invalid';
    }
  }
}
