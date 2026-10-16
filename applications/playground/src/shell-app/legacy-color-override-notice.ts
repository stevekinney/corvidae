/**
 * The one-time notice for the old color-panel session overrides (COR-490). The raw
 * `sessionStorage` JSON is never migrated and never deleted implicitly: the user may
 * download it exactly as stored, and clearing is an explicit action of its own.
 */

/**
 * The `sessionStorage` key the removed color panel wrote its overrides under. Nothing writes it
 * any more; it is kept only so the one-time notice can find, download, and clear what an older
 * session left behind.
 */
export const COLOR_TOKEN_SESSION_KEY = 'cinder-playground-color-token-overrides';

/** The slice of `Storage` the notice uses. */
export type SessionStorageLike = Pick<Storage, 'getItem' | 'removeItem'>;

export type LegacyOverrideNotice = {
  present: true;
  /** The stored text, byte for byte. */
  rawText: string;
  download: { filename: string; mime: string; text: string };
};

export const LEGACY_OVERRIDE_NOTICE_COPY =
  'This browser session still holds color overrides from the old color panel. They are not part of your themes and are not migrated. Download them if you want to keep them, then clear them.';

/** Report stored legacy data, or `null` when there is none (or storage is unreadable). */
export function detectLegacyColorOverrides(
  storage: SessionStorageLike,
): LegacyOverrideNotice | null {
  let rawText: string | null;
  try {
    rawText = storage.getItem(COLOR_TOKEN_SESSION_KEY);
  } catch {
    return null;
  }
  if (rawText === null) return null;
  return {
    present: true,
    rawText,
    download: {
      filename: 'cinder-color-panel-overrides.json',
      mime: 'application/json',
      text: rawText,
    },
  };
}

/** Explicit clear. Returns whether the key is gone afterwards. */
export function clearLegacyColorOverrides(storage: SessionStorageLike): boolean {
  try {
    storage.removeItem(COLOR_TOKEN_SESSION_KEY);
    return storage.getItem(COLOR_TOKEN_SESSION_KEY) === null;
  } catch {
    return false;
  }
}
