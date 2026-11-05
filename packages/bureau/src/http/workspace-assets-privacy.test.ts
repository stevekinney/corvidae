import { WORKSPACE_MOUNT_CONFORMANCE } from './workspace-conformance.test-support.ts';
import { expect, test } from 'bun:test';
import { base64Of, pngBytes } from '../testing/asset-fixtures.test-support.ts';
import { as } from './management/management-fixtures.test-support.ts';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

const actors = Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[];
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
          { declaredByteLength: bytes.byteLength, declaredMediaType: 'image/png' },
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
        if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
        else if (actor === 'owner') expect(result.body?.error).toBeUndefined();
        else {
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
      });
      if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
      else {
        expect(result.body?.error).toBeUndefined();
        const appended = await workspacePrivacyCall(opened, actor, 'bureau.assets.uploads.append', {
          uploadId: result.body?.result?.['uploadId'],
          chunk: base64Of(bytes),
        });
        expect(appended.body?.error).toBeUndefined();
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
      { source: { kind: 'inline', bytes }, readers: [WORKSPACE_PRIVACY_ACTORS.grantee.owner] },
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
      const response = await content(actor, admission.assetId);
      if (actor === 'foreign' || actor === 'removed') {
        expect(metadata.status).toBe(403);
        expect(response.status).toBe(403);
      } else if (actor === 'owner' || actor === 'grantee') {
        expect(metadata.body?.error).toBeUndefined();
        expect(metadata.text).toContain(admission.assetId);
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
      } else {
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
