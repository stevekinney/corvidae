import {
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from 'conversationalist';
import type { ChatProps } from '../../../components/chat/src/lib/components/chat/chat.types.ts';
import type { MarkdownEditorProps } from '../../../components/editor/src/lib/components/markdown-editor/markdown-editor.types.ts';
import type { TerminalProps } from '../../../components/terminal/src/lib/components/terminal/terminal.types.ts';

function author<ElementType extends HTMLElement>(name: string, tag: string) {
  const template = document.querySelector<HTMLTemplateElement>(`#${name}`);
  const element = template?.content.querySelector<ElementType>(tag);
  if (!template || !element) throw new Error(`Missing ${tag} fixture`);
  return { element, mount: () => template.replaceWith(element) };
}

function output(id: string) {
  const element = document.querySelector<HTMLOutputElement>(`#${id}`);
  if (!element) throw new Error(`Missing ${id} fixture output`);
  return element;
}

await Promise.all(
  ['cinder-chat', 'cinder-markdown-editor', 'cinder-terminal'].map((tag) =>
    customElements.whenDefined(tag),
  ),
);

const chat = author<HTMLElement & Pick<ChatProps, 'conversation' | 'onSubmit'>>(
  'chat',
  'cinder-chat',
);
const sent = output('sent-message');
chat.element.conversation = appendAssistantMessage(
  createConversationHistory({ id: 'workspace-fixture' }),
  'Ready to review your draft.',
);
chat.element.onSubmit = ({ message: { content } }) => {
  sent.value =
    typeof content === 'string'
      ? content
      : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
  chat.element.conversation = appendUserMessage(chat.element.conversation, content);
};
chat.mount();

const editor = author<HTMLElement & Pick<MarkdownEditorProps, 'onValueChange'>>(
  'editor',
  'cinder-markdown-editor',
);
const notes = output('saved-notes');
editor.element.onValueChange = (value) => {
  notes.value = value;
};
editor.mount();

const terminal = author<HTMLElement & Pick<TerminalProps, 'controller' | 'ownerGeometry'>>(
  'terminal',
  'cinder-terminal',
);
const parsed = output('parsed-output');
terminal.element.ownerGeometry = { columns: 60, rows: 8 };
terminal.element.controller = {
  subscribeOutput(listener) {
    listener(new TextEncoder().encode('Terminal proof ready'), () => {
      parsed.value = 'Output parsed';
    });
    return () => {};
  },
  rendererFailed(failure) {
    parsed.value = `${failure.phase}: ${failure.message}`;
  },
};
terminal.mount();
