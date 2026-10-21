import { listContexts } from '../../lib/bureau-client.ts';
import { chatSessionPath } from '../../lib/identifier-paths.ts';

/** Where `/` goes: the session updated most recently, or the chat list when there is none. */
export async function chatHomePath(): Promise<string> {
  const page = await listContexts({ limit: 1 });
  const newest = page.contexts[0];
  return newest === undefined ? '/chat' : chatSessionPath(newest.id);
}
