import { httpJsonRpcTransport, type CatalogTransport } from '@lostgradient/backchannel/client';
import { z } from 'zod';

const sessionSchema = z.object({ csrfToken: z.string().min(1) });

/** Acquire the live browser write token only for session-authenticated writes. */
export function settingsTransport(
  baseUrl: string,
  readOperation: string,
  shared: () => boolean,
): CatalogTransport {
  return async (method, input, options) => {
    const headers: Record<string, string> = {};
    if (method !== readOperation && shared()) {
      const session = await fetch('/auth/session', {
        cache: 'no-store',
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!session.ok) throw new Error('The browser session has ended.');
      const data = sessionSchema.parse(await session.json());
      headers['x-csrf-token'] = data.csrfToken;
    }
    return httpJsonRpcTransport({ baseUrl, headers })(method, input, options);
  };
}
