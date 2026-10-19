import { describe, expect, it } from 'bun:test';

import {
  base64Of,
  isoMediaBytes,
  pdfBytes,
  pngBytes,
  textBytes,
  wavBytes,
  zipBytes,
} from '../testing/asset-fixtures.test-support.ts';
import {
  as,
  openBureau,
  type OpenedBureau,
  OWNER,
} from './management/management-fixtures.test-support.ts';

const svg = textBytes(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3"/></svg>',
);

async function withBureau<T>(
  options: Parameters<typeof openBureau>[0],
  body: (opened: OpenedBureau) => Promise<T>,
): Promise<T> {
  const opened = await openBureau(options);
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

/** Admits `bytes` as `owner` and waits for the asset to settle. */
async function admit(
  opened: OpenedBureau,
  bytes: Uint8Array,
  declaredMediaType?: string,
  owner: string = OWNER.alice,
) {
  const admission = await opened.bureau.assets!.admit(
    {
      source: { kind: 'inline', bytes },
      ...(declaredMediaType === undefined ? {} : { declaredMediaType }),
    },
    { id: owner },
  );
  await admission.work.result();
  return admission.assetId;
}

const content = (opened: OpenedBureau, assetId: string, key: string, init: RequestInit = {}) =>
  opened.handler(
    new Request(`http://localhost/assets/${encodeURIComponent(assetId)}/content`, {
      ...init,
      headers: { ...as(key), ...(init.headers as Record<string, string> | undefined) },
    }),
  );

/** The body of `response` with `id`, the one it was asked about, masked, so two bodies compare equal. */
async function maskedBody(response: Response, id: string): Promise<string> {
  const text = await response.text();
  return text.replaceAll(id, '<id>');
}

async function statusOf(pending: Promise<Response>): Promise<number> {
  const response = await pending;
  return response.status;
}

async function jsonOf<T>(pending: Promise<Response>): Promise<T> {
  const response = await pending;
  return (await response.json()) as T;
}

describe('GET /assets/{assetId}/content', () => {
  it('streams the bytes to the owner, with the media type and the two defensive headers', async () => {
    await withBureau({}, async (opened) => {
      const png = pngBytes(4, 3, 64);
      const assetId = await admit(opened, png);

      const response = await content(opened, assetId, 'alice-assets-key');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toBe('sandbox');
      expect(response.headers.get('content-length')).toBe(String(png.byteLength));
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(png));
    });
  });

  // The disposition is decided from the asset's detected media type: only an image other than SVG,
  // audio, and video may be shown by the browser that fetched them.
  it.each([
    ['a PNG', 'image/png', false, pngBytes(4, 3, 64), undefined],
    ['an SVG', 'image/svg+xml', true, svg, 'image/svg+xml'],
    ['a WAV', 'audio/wav', false, wavBytes(), undefined],
    ['an MP4', 'video/mp4', false, isoMediaBytes('mp42'), undefined],
    ['a PDF', 'application/pdf', true, pdfBytes(1), undefined],
    ['plain text', 'text/plain', true, textBytes('hello world'), 'text/plain'],
    [
      'an OOXML document',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      true,
      zipBytes(),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  ] as const)(
    'serves %s as %s (attachment: %p)',
    async (_name, type, attached, bytes, declared) => {
      await withBureau({}, async (opened) => {
        const assetId = await admit(opened, bytes, declared);

        const response = await content(opened, assetId, 'alice-assets-key');

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(type);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('content-security-policy')).toBe('sandbox');
        const disposition = response.headers.get('content-disposition');
        if (attached) expect(disposition).toMatch(/^attachment/);
        else expect(disposition).toBeNull();
        await response.arrayBuffer();
      });
    },
  );

  it('answers a caller without bureau.assets:read 403, and a caller that cannot see the asset exactly as a missing one', async () => {
    await withBureau({}, async (opened) => {
      const assetId = await admit(opened, pngBytes(4, 3, 64));

      const unscoped = await content(opened, assetId, 'alice-key');
      const stranger = await content(opened, assetId, 'bob-assets-key');
      const missing = await content(opened, 'asset-missing', 'bob-assets-key');
      const writeOnly = await content(opened, assetId, 'assets-writer-key');

      expect(unscoped.status).toBe(403);
      expect(writeOnly.status).toBe(403);
      expect(stranger.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await maskedBody(stranger, assetId)).toBe(await maskedBody(missing, 'asset-missing'));
    });
  });

  it('answers a known asset that is not available as an unknown one, with no body that tells them apart', async () => {
    const release = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    await withBureau(
      {
        assetPorts: {
          extractMetadata: async () => {
            reached.resolve();
            await release.promise;
            return {};
          },
        },
      },
      async (opened) => {
        const admission = await opened.bureau.assets!.admit(
          { source: { kind: 'inline', bytes: pngBytes(4, 3, 64) } },
          { id: OWNER.alice },
        );
        await reached.promise;
        // Still pending.
        const pending = await content(opened, admission.assetId, 'alice-assets-key');
        const unknown = await content(opened, 'asset-unknown', 'alice-assets-key');
        release.resolve();
        await admission.work.result();

        expect(pending.status).toBe(404);
        expect(await maskedBody(pending, admission.assetId)).toBe(
          await maskedBody(unknown, 'asset-unknown'),
        );
        // Once available it is served.
        expect(await statusOf(content(opened, admission.assetId, 'alice-assets-key'))).toBe(200);
      },
    );
  });

  it('answers a rejected asset and a deleted one as an unknown one', async () => {
    await withBureau({}, async (opened) => {
      const rejected = await admit(opened, pngBytes(4, 3, 64), 'application/pdf');
      const deletable = await admit(opened, pngBytes(4, 3, 64));
      await opened.bureau.assets!.delete(deletable, { id: OWNER.alice }).result();
      const unknown = await content(opened, 'asset-unknown', 'alice-assets-key');

      for (const assetId of [rejected, deletable]) {
        const response = await content(opened, assetId, 'alice-assets-key');
        expect(response.status).toBe(404);
        expect(await maskedBody(response, assetId)).toBe(
          await maskedBody(unknown.clone(), 'asset-unknown'),
        );
      }
    });
  });

  it('answers an asset whose content a provider holds as an unknown one, and never fetches it', async () => {
    const url = 'https://cdn.example.com/doc.pdf';
    await withBureau({ assetPolicy: { url: { allowProviderFetch: true } } }, async (opened) => {
      const admission = await opened.bureau.assets!.admit(
        {
          source: { kind: 'url', url, fetchedBy: 'provider' },
          declaredMediaType: 'application/pdf',
        },
        { id: OWNER.alice },
      );
      await admission.work.result();
      const descriptor = await opened.bureau.assets!.inspect(admission.assetId, {
        id: OWNER.alice,
      });
      expect(descriptor).toMatchObject({ state: 'available', custody: 'provider-fetch' });

      const response = await content(opened, admission.assetId, 'alice-assets-key');
      const unknown = await content(opened, 'asset-unknown', 'alice-assets-key');

      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body.replaceAll(admission.assetId, '<id>')).toBe(
        await maskedBody(unknown, 'asset-unknown'),
      );
      expect(body).not.toContain('cdn.example.com');
    });
  });

  it('is GET only, and any other path under /assets is not a route', async () => {
    await withBureau({}, async (opened) => {
      const assetId = await admit(opened, pngBytes(4, 3, 64));

      const post = await content(opened, assetId, 'alice-assets-key', { method: 'POST' });
      const wrongSuffix = await opened.handler(
        new Request(`http://localhost/assets/${assetId}/1`, {
          headers: as('alice-assets-key'),
        }),
      );
      const bare = await opened.handler(
        new Request(`http://localhost/assets/${assetId}`, { headers: as('alice-assets-key') }),
      );
      const anonymous = await opened.handler(
        new Request(`http://localhost/assets/${assetId}/content`),
      );

      expect(post.status).toBe(405);
      expect(wrongSuffix.status).toBe(404);
      expect(bare.status).toBe(404);
      expect(anonymous.status).toBe(401);
    });
  });
});

describe('what an uploaded asset looks like on the route', () => {
  it('serves the bytes of an asset completed through the management operations', async () => {
    await withBureau({}, async (opened) => {
      const png = pngBytes(4, 3, 64);
      const post = (method: string, params: unknown) =>
        opened.handler(
          new Request('http://localhost/jsonrpc', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...as('alice-assets-key') },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          }),
        );
      const created = await jsonOf<{ result: { uploadId: string } }>(
        post('bureau.assets.uploads.create', { declaredByteLength: png.byteLength }),
      );
      const { uploadId } = created.result;
      await post('bureau.assets.uploads.append', { uploadId, chunk: base64Of(png) });
      const completed = await jsonOf<{ result: { assetId: string } }>(
        post('bureau.assets.uploads.complete', { uploadId }),
      );

      const response = await content(opened, completed.result.assetId, 'alice-assets-key');

      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(png));
    });
  });
});
