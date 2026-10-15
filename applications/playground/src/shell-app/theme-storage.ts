/**
 * localStorage key for the persisted theme override.
 *
 * Lives in its own module so the documentation page and the pre-paint script
 * can share it without the page importing the shell's larger graph. The
 * pre-paint script in `render-shell.ts` reads this same key before first paint.
 */
export const THEME_STORAGE_KEY = 'cinder-playground-theme';
