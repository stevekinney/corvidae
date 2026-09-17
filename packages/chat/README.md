# @repo/chat

`ChatMessage` owns streaming, adapter-provided message metadata, and tool-call presentation; `Chat` and `ChatAdapter` own conversation state and transport. See the [editor/chat/Cinder surface boundary](https://github.com/stevekinney/cinder/blob/main/docs/decisions/editor-chat-cinder-surfaces.md) for the intentional distinction from Cinder's domain-neutral `Message`.

`@repo/chat` is Cinder's Svelte 5 conversation surface, packaged separately so applications that do not render Chat do not install or bundle its conversation-model dependencies.

## Workspace usage

Declare `"@repo/chat": "workspace:*"` in the consuming workspace's dependencies and run `bun install` from the Corvidae root. Shared external versions come from the root Bun catalog. This private package exports TypeScript and Svelte source; the application compiles it.

Chat declares its Cinder, Markdown, Conversationalist, and Svelte dependencies directly. Add an explicit dependency in your own workspace when you import one of those packages yourself. Import Chat's conversation surface and supported types from `@repo/chat`; import headless conversation APIs from `@repo/conversationalist`.

## Components

- `@repo/chat` — the Chat surface, conversation builders, model types, adapter types, message primitives, and export utilities.
- `@repo/chat` — slash-command and mention suggestions anchored to `ChatInput`.
- `@repo/chat` — active-conversation title, metadata, and export controls.
- `@repo/chat` — conversation navigation, summaries, unread counts, and selection.

Each component entry also publishes `/schema`, `/variables`, `/styles`, and `/examples` artifacts. The package-wide machine-readable index is available from `@repo/chat`.

## Connecting artifacts to messages

Store artifact data in `message.metadata['cinder:artifact']` using the exported `ChatArtifact` shape:

```ts
import type { MessageInput } from '@repo/chat';

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
  import { ArtifactViewer } from '@repo/chat';
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

`Chat`'s per-row and per-part overrides (`row`, `messagePart`) are inversion-of-control snippets: each receives the thing being rendered plus a `renderDefault` snippet that renders Chat's own built-in output for it. Supplying an override wraps the built-in rendering rather than replacing it outright — a consumer adds markup around `renderDefault()`'s output, or conditionally calls it, but the built-in behavior stays reachable:

```svelte
{#snippet messagePart(part, renderDefault)}
  <div class="my-wrapper">
    {@render renderDefault(part)}
  </div>
{/snippet}
```

This is a deliberate difference from `@repo/editor`'s `DiffViewer`, whose `toolbar` override is total replacement with no `renderDefault` — see the "DiffViewer toolbar override" section of [`@repo/editor`'s README](https://github.com/stevekinney/cinder/blob/main/packages/editor/README.md) for why. Message-part and row rendering carry built-in behavior (streaming state, tool-call presentation, artifact resolution) that most wrappers want to keep and only augment, which is what `renderDefault` is for.
