# @lostgradient/chat

`@lostgradient/chat` is the [Svelte](https://svelte.dev/) conversation surface for Corvidae. It stays separate from [Cinder](../cinder/README.md) so an application that only needs domain-neutral interface primitives does not also pull in conversation state, transport adapters, and tool-call presentation.

`Chat` and `ChatAdapter` own conversation state and transport. `ChatMessage` owns streaming presentation, adapter-provided metadata, and tool calls. Cinder's `Message` remains the smaller, domain-neutral primitive.

## Workspace usage

Declare `"@lostgradient/chat": "workspace:*"` in the consuming workspace's dependencies and run `bun install` from the Corvidae root. Shared external versions come from the root Bun catalog. This private package exports TypeScript and Svelte source; the application compiles it.

Chat declares its Cinder, Markdown, Conversationalist, and Svelte dependencies directly. Add an explicit dependency in your own workspace when you import one of those packages yourself. Import Chat's conversation surface and supported types from `@lostgradient/chat`; import headless conversation APIs from `conversationalist`.

## Components

- `Chat` provides the conversation surface, builders, model types, adapter types, message primitives, and export utilities.
- `ChatComposerPopover` provides slash-command and mention suggestions anchored to `ChatInput`.
- `ChatConversationHeader` provides the active-conversation title, metadata, and export controls.
- `ChatConversationList` and `ChatNavigationRail` provide conversation summaries, unread counts, navigation, and selection.

The package has one public entry point. It exports the supported components, types, schemas, variables, styles, and examples from `@lostgradient/chat`; the repository-only `components.json` manifest is not a package export.

## Connecting artifacts to messages

Store artifact data in `message.metadata['cinder:artifact']` using the exported `ChatArtifact` shape:

```ts
import type { MessageInput } from '@lostgradient/chat';

const result: MessageInput = {
  role: 'tool-result',
  content: '',
  metadata: {
    'cinder:artifact': {
      type: 'code',
      content: '{ "status": "ok" }',
      language: 'json',
      title: 'Tool report',
    },
  },
  toolResult: {
    callId: 'call-report',
    outcome: 'success',
    content: { status: 'ok' },
  },
};
```

`ChatArtifact` contains `type`, `content`, and optional `language` and `title` fields, matching the serializable `ArtifactViewer` props. `resolveMessageArtifact(message)` validates direct metadata access. Every `ChatRowContext` also exposes `artifact`; when a paired tool-result row is folded into its tool-call row, Chat resolves artifact metadata from the hidden result message automatically. Metadata on the visible message takes precedence when both messages define an artifact.

Use `messageActions` to open application-owned panel state, then render the selected descriptor with `ChatArtifactLayout` and `ArtifactViewer`. Chat does not open panels automatically because selection and close behavior belong to the containing application.

## Rendering Mermaid artifacts

`ArtifactViewer` renders HTML and SVG in sandboxed iframes. Code artifacts use Cinder's `CodeBlock` with the artifact language for lazy syntax highlighting; pass `codeRenderer` when an application needs a custom code viewer. Mermaid stays consumer-owned so applications can choose their Mermaid version, configuration, and security policy. Without a renderer, Mermaid artifacts show their source and an explicit fallback note.

The `codeRenderer` snippet receives `(content, 'code', language)` and is invoked only for code artifacts:

```svelte
{#snippet codeRenderer(source, _type, language)}
  <MyCodeViewer {source} {language} />
{/snippet}

<ArtifactViewer type="code" content={source} language="svelte" {codeRenderer} />
```

Pass a `mermaidRenderer` snippet to delegate only the Mermaid branch to an application component:

```svelte
<script lang="ts">
  import { ArtifactViewer } from '@lostgradient/chat';
  import MermaidDiagram from './mermaid-diagram.svelte';

  const content = 'graph TD; Request-->Response;';
</script>

{#snippet mermaidRenderer(source, contentType)}
  <MermaidDiagram {source} ariaLabel={`${contentType} diagram`} />
{/snippet}

<ArtifactViewer type="mermaid" {content} {mermaidRenderer} />
```

The Mermaid snippet has type `Snippet<[content: string, type: 'mermaid']>`. `ArtifactViewer` invokes it only when `type` is `mermaid`; HTML, SVG, and code continue through their built-in renderers unless a code snippet is supplied. The application-owned component is responsible for loading Mermaid, handling asynchronous rendering and errors, and applying its required content-safety policy.

## Attachments

`ChatInput` (and `Chat`, which forwards the props) takes files by picker, paste and drop. `maxFileSize` and `acceptedTypes` bound them, and a file that fails either shows as an `error` attachment, with the words from `formatAttachmentError`, and is never read or uploaded.

`uploadAttachment(file, { signal })` uploads each file as soon as it is attached and answers a reference (`{ id, mimeType? }`). The attachment is `uploading` until the hook settles, then `ready` (carrying the reference as `ChatAttachment.reference`) or `error` when it rejects; the preview's `data-state` says which, Send stays disabled while any attachment is `uploading`, and the signal aborts when the attachment is removed or the composer goes away. A promoted text paste is sent inline and is not uploaded. Chat reads neither field of the reference: the host's `adapter` receives the attachments, with their references, on submit. `capabilities.attachments` turns the picker, paste and drop off.

## Overriding built-in rendering

`Chat`'s per-row and per-part overrides (`row`, `messagePart`) are inversion-of-control snippets: each receives the thing being rendered plus a `renderDefault` snippet that renders Chat's own built-in output for it. Supplying an override wraps the built-in rendering rather than replacing it outright—a consumer adds markup around `renderDefault()`'s output, or conditionally calls it, but the built-in behavior stays reachable:

```svelte
{#snippet messagePart(part, renderDefault)}
  <div class="my-wrapper">
    {@render renderDefault(part)}
  </div>
{/snippet}
```

This is a deliberate difference from `@lostgradient/editor`'s `DiffViewer`, whose `toolbar` override is total replacement with no `renderDefault`—the [Editor README](../editor/README.md#diffviewer-toolbar-override) explains why. Message-part and row rendering carry built-in behavior (streaming state, tool-call presentation, artifact resolution) that most wrappers want to keep and only augment. That is what `renderDefault` is for.

## AG-UI transport

`createChatSessionController` can be driven by an [AG-UI](https://docs.ag-ui.com) 1.0 event stream without changing the native chat wire. `createAGUIChatTransport` returns a chat session transport that maps each event onto the version 3 wire, and `mapAGUIEventsToChatStream` is the same mapping over any iterable of events.

```ts
import {
  createAGUIChatTransport,
  createChatSessionController,
  type ConversationHistory,
} from '@lostgradient/chat';

declare function getConversation(): ConversationHistory;
declare function setConversation(conversation: ConversationHistory): void;
// Your agent endpoint, yielding AG-UI 1.0 events for this conversation.
declare function runAgent(
  conversation: ConversationHistory,
  signal: AbortSignal,
): AsyncIterable<unknown>;

const controller = createChatSessionController({
  executionOwner: 'server',
  getConversation,
  setConversation,
  transport: createAGUIChatTransport((request) => runAgent(request.conversation, request.signal)),
});
```

Every event is validated against the pinned `@ag-ui/core` schema, and an invalid or out-of-order one fails the run with an `AGUIChatTransportError`. `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_*`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `REASONING_*`, and `MESSAGES_SNAPSHOT` are mapped. The types in `AG_UI_UNSUPPORTED_EVENT_TYPES` (state, activity, raw, custom, and subagent events) are validated and then ignored, as is any event that carries a `subagentRunId`.

The client's rows are authoritative. The terminal `run.completed` frame carries the history the run was asked from, grown by each `MESSAGES_SNAPSHOT` and then by the messages the run produced, merged by message id: a snapshot or a streamed message adds the rows the client lacks and never deletes or rewrites one it has, and a mid-run snapshot does not discard what the run had already produced. Messages land in the order they started, and the AG-UI message ids become the row ids, so a streamed assistant row keeps its wire `messageId`. That merge is row for row when the backend echoes the ids of the run input, as AG-UI backends do. A snapshot that shares no message with a thread the client already holds is not a copy of it: its earlier history is not merged a second time, but the messages after its last user message (all of it, when it holds none) are this turn's output and are kept. A message still streaming is left out of a snapshot because its whole row is written when it ends. A tool call is filed under the assistant message it names as its parent, so it gets the row id a snapshot of the same thread gives it. Messages that overlap are written to the wire one at a time, in the order they started, because a version 3 stream has one open step at a time. Text from another role (the user's own message echoed back, a system or developer message) is not added to history, and a `RUN_FINISHED` interrupt outcome completes the run without surfacing its interrupt details, which the resume flow will map to elicitation. A `RUN_ERROR` keeps the backend's code as `backendCode`. Use `executionOwner: 'server'`: the AG-UI backend runs the whole turn.
