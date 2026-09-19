<script lang="ts">
  import { Button } from '@corvidae/cinder';
  import { ReviewEditor } from '@corvidae/editor';
  import type { Thread, ThreadDeleteEvent } from '@corvidae/editor';
  const original = `# Architecture Notes

This document describes the review workflow for collaborative editing.

## Feedback

Comments should stay anchored when nearby text changes. Export actions should produce summaries, unified diffs, and comment markdown.`;

  let value = $state(`---
owner: platform
status: draft
---

# Architecture Notes

This document describes the review workflow for collaborative editing and handoff.

## Feedback

Comments should stay anchored when nearby text changes. Export actions should produce summaries, unified diffs, and comment markdown.

## Follow-up

The editor should make source, rendered, and diff modes available without leaving the review context.`);

  // Anchor positions are ProseMirror positions against the full document, never
  // indices into the Markdown string. "Architecture Notes" occupies body
  // positions 1..19 in the parsed document, and its doc.textBetween() offset —
  // which is what lastKnownOffset stores — is 0. The front matter above is 38
  // characters, and the component subtracts that before handing anchors to the
  // editor, so the values below are the body numbers plus 38.
  // prefix/suffix are text too: heading markup like "# " appears in no text
  // space at all, and textBetween joins blocks with a single newline.
  let threads = $state<Thread[]>([
    {
      id: 'thread-architecture-title',
      createdAt: '2026-04-30T12:00:00.000Z',
      anchor: {
        from: 39,
        to: 57,
        quote: 'Architecture Notes',
        prefix: '',
        suffix: '\nThis document describes the review workflow for ',
        status: 'anchored',
        originalQuote: 'Architecture Notes',
        lastKnownOffset: 38,
      },
      comments: [
        {
          id: 'comment-title',
          threadId: 'thread-architecture-title',
          authorId: 'maya',
          body: 'This title is clear. I would keep it.',
          createdAt: '2026-04-30T12:00:00.000Z',
        },
      ],
    },
    {
      id: 'thread-document',
      createdAt: '2026-04-30T12:10:00.000Z',
      anchor: {
        type: 'document',
        from: 0,
        to: 0,
        quote: '',
        prefix: '',
        suffix: '',
        status: 'anchored',
        originalQuote: '',
      },
      comments: [
        {
          id: 'comment-document',
          threadId: 'thread-document',
          authorId: 'steve',
          body: 'The overall shape is ready for review.',
          createdAt: '2026-04-30T12:10:00.000Z',
        },
      ],
    },
    {
      id: 'thread-follow-up',
      createdAt: '2026-04-30T12:20:00.000Z',
      anchor: {
        from: 254,
        to: 263,
        quote: 'handoff',
        prefix: 'collaborative editing and ',
        suffix: '.\n\nFeedback',
        status: 'anchored',
        originalQuote: 'handoff',
        lastKnownOffset: 216,
      },
      comments: [
        {
          id: 'comment-follow-up',
          threadId: 'thread-follow-up',
          authorId: 'maya',
          body: 'Please keep the handoff notes visible in the exported summary.',
          createdAt: '2026-04-30T12:20:00.000Z',
        },
      ],
    },
  ]);

  let documentRemovalAllowed = $state(false);

  function handleThreadDelete(event: ThreadDeleteEvent): void {
    if (event.threadId === 'thread-document' && !documentRemovalAllowed) return;
    threads = threads.filter((thread) => thread.id !== event.threadId);
    queueMicrotask(() => {
      threads = [...threads];
    });
  }
</script>

<div id="example-mount-with-comments" style="min-height: 38rem;">
  <ReviewEditor
    id="playground-review-editor-comments"
    {original}
    bind:value
    bind:threads
    currentUserId="steve"
    onthreaddelete={handleThreadDelete}
  />
  <Button size="xs" variant="secondary" onclick={() => (documentRemovalAllowed = true)}>
    Allow document thread removal
  </Button>
</div>
