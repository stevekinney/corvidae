import { z } from 'zod';

const settingsAccessSchema = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(false) }).strict(),
  z.object({ allowed: z.literal(true), scope: z.string().regex(/^[0-9a-f]{64}$/u) }).strict(),
]);

/** A private Settings decision. Metadata only comes from the authorized operation client. */
export type SettingsAccess = z.infer<typeof settingsAccessSchema>;

/** Fetch the live decision without carrying credentials or metadata through page data. */
export async function readSettingsAccess(
  path: string,
  fetchRequest: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  signal?: AbortSignal,
): Promise<SettingsAccess> {
  const response = await fetchRequest(path, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.status === 401 || response.status === 403) return { allowed: false };
  if (!response.ok) throw new Error('Settings access is unavailable.');
  return settingsAccessSchema.parse(await response.json());
}
