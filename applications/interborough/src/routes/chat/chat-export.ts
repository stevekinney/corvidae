import { getMessageText, type ConversationHistory } from '@lostgradient/chat';

/** The media type of the file the export saves. */
export const CHAT_EXPORT_TYPE = 'text/markdown';

const SPEAKERS: Readonly<Record<string, string>> = { user: 'You', assistant: 'Assistant' };

/** The sections of the export: what each message the person sent or the agent replied with said. */
function sectionsOf(conversation: ConversationHistory): string[] {
  return conversation.ids.flatMap((id) => {
    const message = conversation.messages[id];
    if (message === undefined || message.hidden) return [];
    const speaker = SPEAKERS[message.role];
    if (speaker === undefined) return [];
    const text = getMessageText(message).trim();
    return text === '' ? [] : [`## ${speaker}\n\n${text}`];
  });
}

/** Whether the conversation has anything to export. */
export function hasExportableText(conversation: ConversationHistory): boolean {
  return sectionsOf(conversation).length > 0;
}

/**
 * The conversation as a Markdown document a person can keep: the title, the agent, and each
 * message the person sent or the agent replied with, in order. Tool calls and their results, and
 * rows the page holds for its own reading (hidden rows), are not part of what was said, so they
 * are left out; a message with no text of its own (files only) is left out with them.
 */
export function chatMarkdown(input: {
  readonly title: string;
  readonly agent: string;
  readonly conversation: ConversationHistory;
}): string {
  return (
    [`# ${input.title}`, `Agent: \`${input.agent}\``, ...sectionsOf(input.conversation)].join(
      '\n\n',
    ) + '\n'
  );
}

/** The characters a file system refuses. */
const UNSAFE_FILENAME = /[\\/:*?"<>|]+/g;

/** The file's name: the chat's title with nothing a file system refuses, and the day it was exported. */
export function chatExportFilename(title: string, now: Date = new Date()): string {
  const base = title
    .replace(/\p{Cc}/gu, '')
    .replace(UNSAFE_FILENAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base === '' ? 'chat' : base}-${now.toISOString().slice(0, 10)}.md`;
}
