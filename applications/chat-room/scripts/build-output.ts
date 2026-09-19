/** Browser output stays outside the normal build's .svelte-kit/** cache entry. */
export const BROWSER_OUTPUT_DIRECTORY = '.playwright/svelte-kit';

/** Match the output selected by the build and the process that inspects it. */
export function buildOutputDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment['CHAT_ROOM_BROWSER'] === '1' ? BROWSER_OUTPUT_DIRECTORY : '.svelte-kit';
}
