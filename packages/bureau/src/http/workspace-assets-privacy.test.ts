import { rejectionOf } from '@lostgradient/testing';
import {
  runtimeWorkspaceOwnerAuthority,
  type WorkspaceMembership,
  type WorkspaceMembershipOptions,
} from './workspace-principal.ts';
import { WORKSPACE_MOUNT_CONFORMANCE } from './workspace-conformance.test-support.ts';
import {
  workspaceConformanceLedger,
  workspaceMountLedger,
} from './workspace-conformance-ledger.test-support.ts';
import { expect, test } from 'bun:test';
import { base64Of, pngBytes } from '../testing/asset-fixtures.test-support.ts';
import { as, openBureau } from './management/management-fixtures.test-support.ts';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  workspacePrivacyAuthentication,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

const actors = Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[];
const witnesses = workspaceConformanceLedger('workspace-assets-privacy.test.ts');
const mountWitnesses = workspaceMountLedger('workspace-assets-privacy.test.ts');
const bytes = pngBytes(4, 3, 64);
const uploadCases = ['append', 'complete', 'abort'] as const;

for (const action of uploadCases) {
  test(`bureau.assets.uploads.${action} protects the upload across six actors`, async () => {
    const opened = await openWorkspacePrivacyBureau();
    try {
      // Each actor gets an independent owner upload so mutation cannot invalidate another case.
      for (const actor of actors) {
        const created = await workspacePrivacyCall(
          opened,
          'owner',
          'bureau.assets.uploads.create',
          {
            declaredByteLength: bytes.byteLength,
            declaredMediaType:
              action === 'append' ? 'application/x-private-media-92f4' : 'image/png',
          },
        );
        expect(created.body?.error).toBeUndefined();
        const uploadId = created.body?.result?.['uploadId'];
        expect(typeof uploadId).toBe('string');
        if (action === 'complete') {
          const appended = await workspacePrivacyCall(
            opened,
            'owner',
            'bureau.assets.uploads.append',
            { uploadId, chunk: base64Of(bytes) },
          );
          expect(appended.body?.error).toBeUndefined();
        }
        const parameters = { uploadId, ...(action === 'append' ? { chunk: base64Of(bytes) } : {}) };
        const result = await workspacePrivacyCall(
          opened,
          actor,
          `bureau.assets.uploads.${action}`,
          parameters,
        );
        if (action === 'abort')
          witnesses.observeScalar(`bureau.assets.uploads.${action}`, actor, result, 'aborted');
        else witnesses.observeWire(`bureau.assets.uploads.${action}`, actor, result);
        if (action === 'append')
          witnesses.observePrivateProjection('bureau.assets.uploads.append', actor, result);
        if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
        else if (actor === 'owner') {
          expect(result.body?.error).toBeUndefined();
          if (action === 'complete')
            expect(result.body?.result).toMatchObject({ fileName: null, rejection: null });
        } else {
          if (action === 'abort') expect(result.body?.result?.['aborted']).toBe(false);
          else expect(result.body?.error?.data?.httpStatus).toBe(404);
          const unknown = await workspacePrivacyCall(
            opened,
            actor,
            `bureau.assets.uploads.${action}`,
            { ...parameters, uploadId: 'unknown-upload' },
          );
          expect(JSON.stringify(result.body).replaceAll(String(uploadId), '<id>')).toBe(
            JSON.stringify(unknown.body).replaceAll('unknown-upload', '<id>'),
          );
          if (action === 'abort') {
            const retained = await workspacePrivacyCall(
              opened,
              'owner',
              'bureau.assets.uploads.append',
              { uploadId, chunk: base64Of(bytes) },
            );
            expect(retained.body?.error).toBeUndefined();
          }
          expect(result.text).not.toContain(base64Of(bytes));
        }
      }
    } finally {
      await opened.dispose();
    }
  });
}

test('bureau.assets.uploads.create admits only current members and assigns their own uploads', async () => {
  const opened = await openWorkspacePrivacyBureau();
  try {
    for (const actor of actors) {
      const result = await workspacePrivacyCall(opened, actor, 'bureau.assets.uploads.create', {
        declaredByteLength: bytes.byteLength,
        declaredMediaType: 'application/x-private-media-92f4',
      });
      witnesses.observePrivateProjection('bureau.assets.uploads.create', actor, result);
      if (actor === 'foreign' || actor === 'removed') {
        expect(result.status).toBe(403);
        witnesses.observeCreated('bureau.assets.uploads.create', actor, result, false);
      } else {
        expect(result.body?.error).toBeUndefined();
        const appended = await workspacePrivacyCall(opened, actor, 'bureau.assets.uploads.append', {
          uploadId: result.body?.result?.['uploadId'],
          chunk: base64Of(bytes),
        });
        expect(appended.body?.error).toBeUndefined();
        const other = actor === 'peer' ? 'owner' : 'peer';
        const denied = await workspacePrivacyCall(opened, other, 'bureau.assets.uploads.append', {
          uploadId: result.body?.result?.['uploadId'],
          chunk: base64Of(bytes),
        });
        witnesses.observeCreated(
          'bureau.assets.uploads.create',
          actor,
          result,
          appended.body?.error === undefined && denied.body?.error?.data?.httpStatus === 404,
        );
      }
    }
  } finally {
    await opened.dispose();
  }
});

test('asset metadata and HTTP bytes honor only the owner and explicit current-member reader', async () => {
  const opened = await openWorkspacePrivacyBureau();
  try {
    const admission = await opened.bureau.assets!.admit(
      {
        source: { kind: 'inline', bytes },
        fileName: 'PRIVATE-ASSET-NAME-92f4.png',
        readers: [WORKSPACE_PRIVACY_ACTORS.grantee.owner],
      },
      { id: WORKSPACE_PRIVACY_ACTORS.owner.owner },
    );
    await admission.work.result();
    const content = (actor: WorkspacePrivacyActor, id: string) =>
      opened.handler(
        new Request(`http://localhost${WORKSPACE_MOUNT_CONFORMANCE.assets.key}/${id}/content`, {
          headers: as(WORKSPACE_PRIVACY_ACTORS[actor].key),
        }),
      );
    for (const actor of actors) {
      const metadata = await workspacePrivacyCall(opened, actor, 'bureau.assets.get', {
        assetId: admission.assetId,
      });
      witnesses.observeWire('bureau.assets.get', actor, metadata);
      witnesses.observePrivateIdentifier('bureau.assets.get', actor, metadata, admission.assetId);
      if (actor !== 'owner' && actor !== 'grantee')
        expect(metadata.text).not.toContain('PRIVATE-ASSET-NAME-92f4.png');
      const response = await content(actor, admission.assetId);
      await mountWitnesses.observeHttp(
        WORKSPACE_MOUNT_CONFORMANCE.assets.key,
        actor,
        response,
        bytes,
      );
      if (actor === 'foreign' || actor === 'removed') {
        expect(metadata.status).toBe(403);
        expect(response.status).toBe(403);
      } else if (actor === 'owner' || actor === 'grantee') {
        expect(metadata.body?.error).toBeUndefined();
        expect(metadata.text).toContain(admission.assetId);
        expect(metadata.text).toContain('PRIVATE-ASSET-NAME-92f4.png');
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
      } else {
        expect(metadata.text).not.toContain('PRIVATE-ASSET-NAME-92f4.png');
        expect(metadata.body?.error?.data?.httpStatus).toBe(404);
        const unknown = await workspacePrivacyCall(opened, actor, 'bureau.assets.get', {
          assetId: 'unknown-asset',
        });
        expect(JSON.stringify(metadata.body?.error).replaceAll(admission.assetId, '<id>')).toBe(
          JSON.stringify(unknown.body?.error).replaceAll('unknown-asset', '<id>'),
        );
        expect(response.status).toBe(404);
        const unknownContent = await content(actor, 'unknown-asset');
        const refusedText = await response.text();
        const missingText = await unknownContent.text();
        expect(refusedText.replaceAll(admission.assetId, '<id>')).toBe(
          missingText.replaceAll('unknown-asset', '<id>'),
        );
      }
    }
  } finally {
    await opened.dispose();
  }
});

test('a service cannot spend a persisted cross-owner asset grant over HTTP or runtime reads', async () => {
  const owner: WorkspaceMembership = {
    version: 1,
    workspaceId: 'workspace-a',
    actorId: 'alice',
    actorKind: 'user',
    owner: WORKSPACE_PRIVACY_ACTORS.owner.owner,
    membershipRevision: '1',
    capabilities: ['workspace:use'],
  };
  const service: WorkspaceMembership = {
    ...owner,
    actorId: 'service',
    actorKind: 'service',
    owner: WORKSPACE_PRIVACY_ACTORS.grantee.owner,
  };
  const workspace: WorkspaceMembershipOptions = {
    workspaceId: 'workspace-a',
    resolveMembership: async ({ subject }) =>
      subject === 'alice' ? owner : subject === 'assets-reader' ? service : null,
    resolveOwnerMembership: async (identifier) =>
      identifier === owner.owner ? owner : identifier === service.owner ? service : null,
  };
  const opened = await openBureau({
    authentication: workspacePrivacyAuthentication,
    handlerOptions: { workspace },
  });
  try {
    // Trusted fixture writes a pre-existing grant; callers cannot supply directory authority.
    const shared = await opened.bureau.assets!.admit(
      { source: { kind: 'inline', bytes }, readers: [service.owner] },
      { id: owner.owner },
    );
    await shared.work.result();
    const result = await workspacePrivacyCall(opened, 'grantee', 'bureau.assets.get', {
      assetId: shared.assetId,
    });
    expect(result.body?.error?.data?.httpStatus).toBe(404);
    const response = await opened.handler(
      new Request(`http://localhost/assets/${shared.assetId}/content`, {
        headers: as(WORKSPACE_PRIVACY_ACTORS.grantee.key),
      }),
    );
    expect(response.status).toBe(404);
    const principal = {
      id: service.owner,
      workspaceAuthority: runtimeWorkspaceOwnerAuthority(workspace, service.owner),
    };
    expect(
      await rejectionOf(opened.bureau.assets!.inspect(shared.assetId, principal)),
    ).toMatchObject({ name: 'AssetNotFoundError' });
    const own = await opened.bureau.assets!.admit({ source: { kind: 'inline', bytes } }, principal);
    await own.work.result();
    const ownResult = await workspacePrivacyCall(opened, 'grantee', 'bureau.assets.get', {
      assetId: own.assetId,
    });
    expect(ownResult.body?.error).toBeUndefined();
  } finally {
    await opened.dispose();
  }
});

test('the workspace operation inventory has six executed actor witnesses', () => {
  witnesses.verify();
  mountWitnesses.verify();
});
