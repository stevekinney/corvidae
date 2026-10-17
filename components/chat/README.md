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
const controller = createChatSessionController({
  executionOwner: 'server',
  getConversation,
  setConversation,
  transport: createAGUIChatTransport((request) => runAgent(request.conversation, request.signal)),
});
```

Every event is validated against the pinned `@ag-ui/core` schema, and an invalid or out-of-order one fails the run with an `AGUIChatTransportError`. `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_*`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `REASONING_*`, and `MESSAGES_SNAPSHOT` are mapped; the types in `AG_UI_UNSUPPORTED_EVENT_TYPES` (state, activity, raw, custom, and subagent events) are validated and then ignored. The terminal `run.completed` frame carries the last `MESSAGES_SNAPSHOT` plus everything the run produced afterward, or the history the run was asked from when the stream sends no snapshot, so use `executionOwner: 'server'`: the AG-UI backend runs the whole turn.
