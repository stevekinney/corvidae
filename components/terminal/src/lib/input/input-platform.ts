import type { InputPlatform } from './input-types.ts';

type NavigatorWithPlatform = {
  userAgentData?: { platform?: string };
  platform?: string;
};

/**
 * The platform family key routing needs: Cmd and the Mac reserved chords against Ctrl and the rest.
 * Reads the User-Agent Client Hints platform when the browser has it, then `navigator.platform`.
 * Anything unrecognised is `other`, whose chords are the ones a terminal user expects.
 */
export function detectInputPlatform(
  navigatorLike: NavigatorWithPlatform | null = typeof navigator === 'undefined' ? null : navigator,
): InputPlatform {
  const name = navigatorLike?.userAgentData?.platform ?? navigatorLike?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(name) ? 'mac' : 'other';
}
