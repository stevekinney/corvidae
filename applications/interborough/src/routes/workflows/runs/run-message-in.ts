/**
 * The message that started a run, read from the chat thread the run belongs to. A thread is AG-UI
 * messages, and the rows a run wrote are named `<runId>:step:<n>` (`run-tool-calls.ts`), so the
 * message in is the last `user` row before the first row of this run. A user row's content is text,
 * or a list of parts whose text parts are joined.
 */
import { z } from 'zod';

const userSchema = z.object({
  id: z.string(),
  role: z.literal('user'),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
});
const partSchema = z.object({ type: z.literal('text'), text: z.string() });

function textOf(content: string | readonly unknown[] | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      const parsed = partSchema.safeParse(part);
      return parsed.success ? parsed.data.text : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

/** The `id` a stored message carries, or `undefined` for a message without one. */
function idOf(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) return undefined;
  return Object.getOwnPropertyDescriptor(message, 'id')?.value;
}

/**
 * The text of the message that started the run `runId`, or `undefined` when the thread holds no
 * row of the run, or no user message before it, or that message has no text (an attachment alone).
 */
export function messageInOfRun(runId: string, messages: readonly unknown[]): string | undefined {
  let lastUser: string | undefined;
  for (const message of messages) {
    const user = userSchema.safeParse(message);
    if (user.success) {
      const text = textOf(user.data.content);
      lastUser = text === '' ? undefined : text;
      continue;
    }
    const id = idOf(message);
    if (typeof id === 'string' && id.startsWith(`${runId}:`)) return lastUser;
  }
  return undefined;
}
