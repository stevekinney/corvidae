<script lang="ts" module>
  import type { HTMLAttributes } from 'svelte/elements';
  import type { ChatMarkdownNode, MarkdownNodeOverride } from './chat-message-parts.ts';

  export type ChatMarkdownPreviewProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
    content: string;
    class?: string;
    markdownNode?: MarkdownNodeOverride | undefined;
    /** `false` renders each image as its alt text, so the content loads nothing. Default `true`. */
    images?: boolean | undefined;
    /** `false` renders each link as its text, so the content navigates nowhere. Default `true`. */
    links?: boolean | undefined;
  };

  export type MarkdownSegment =
    | { kind: 'html'; html: string }
    | { kind: 'node'; node: ChatMarkdownNode }
    | {
        kind: 'element';
        tag: string;
        attributes: Record<string, string>;
        children: MarkdownSegment[];
      };

  function serializeNode(node: Node, ownerDocument: Document): string {
    const container = ownerDocument.createElement('div');
    container.append(node.cloneNode(true));
    return container.innerHTML;
  }

  function segmentNode(
    node: Node,
    fallbackIndex: number,
    ownerDocument: Document,
  ): MarkdownSegment {
    if (node.nodeType !== 1) return { kind: 'html', html: serializeNode(node, ownerDocument) };
    const element = node as HTMLElement;
    if (element.matches('cinder-markdown-node')) {
      return {
        kind: 'node',
        node: {
          kind: element.dataset['cinderMarkdownKind'] as ChatMarkdownNode['kind'],
          html: element.innerHTML,
          text: element.textContent ?? '',
          language: element.dataset['language'],
          index: Number(element.dataset['cinderMarkdownIndex'] ?? fallbackIndex),
        },
      };
    }
    if (!element.querySelector('cinder-markdown-node')) {
      return { kind: 'html', html: element.outerHTML };
    }
    return {
      kind: 'element',
      tag: element.tagName.toLowerCase(),
      attributes: Object.fromEntries(
        Array.from(element.attributes, (attribute) => [attribute.name, attribute.value]),
      ),
      children: Array.from(element.childNodes, (child, index) =>
        segmentNode(child, fallbackIndex + index, ownerDocument),
      ),
    };
  }

  /**
   * Preserves placeholder ancestors so nested markdown nodes remain overridable.
   * With `images: false`, each image becomes its alt text while the markup is
   * still inert, so nothing it names is ever fetched; with `links: false`, each
   * link becomes its text, so nothing in it navigates.
   */
  export function segmentRenderedMarkdown(
    html: string,
    ownerDocument: Document = document,
    options: { readonly images?: boolean | undefined; readonly links?: boolean | undefined } = {},
  ): MarkdownSegment[] {
    const template = ownerDocument.createElement('template');
    template.innerHTML = html;
    if (options.images === false) {
      for (const image of template.content.querySelectorAll('img')) {
        image.replaceWith(ownerDocument.createTextNode(image.getAttribute('alt') ?? ''));
      }
      for (const source of template.content.querySelectorAll('picture, source')) source.remove();
    }
    if (options.links === false) {
      for (const link of template.content.querySelectorAll('a'))
        link.replaceWith(...link.childNodes);
    }
    return Array.from(template.content.childNodes, (child, index) =>
      segmentNode(child, index, ownerDocument),
    );
  }
</script>

<script lang="ts">
  import { classNames } from '../../../utilities/class-names.ts';
  import { CodeBlock } from '@lostgradient/cinder';
  import { preloadMarkdownPipeline } from './markdown-pipeline.ts';
  import MarkdownTableScroller from './markdown-table-scroller.svelte';

  let {
    content,
    markdownNode,
    images = true,
    links = true,
    class: className,
    ...rest
  }: ChatMarkdownPreviewProps = $props();

  /** One committed render: the source it was made from, the policy it obeyed, and its output. */
  type RenderedMarkdown = {
    source: string;
    images: boolean;
    links: boolean;
    html: string;
    segments: MarkdownSegment[];
  };

  let rendered = $state<RenderedMarkdown | undefined>(undefined);

  // Plain bookkeeping, never read by the template or tracked by an effect. Each effect run takes
  // the next generation before its render awaits; a result commits only when no newer generation
  // has committed already, so a slower earlier render can never replace a newer snapshot. The
  // epoch moves whenever the content stops being an append of the previous snapshot or the
  // link/image policy changes, and a render from an earlier epoch never commits.
  let latestGeneration = 0;
  let committedGeneration = 0;
  let epoch = 0;
  let previousSnapshot: { content: string; images: boolean; links: boolean } | undefined;

  /**
   * Whether `next` only appends to `source`. Trailing whitespace on the source is ignored, because
   * a streamed message can drop the blank line at its end when a code fence closes, and Markdown
   * renders the same either way.
   */
  function extendsSource(next: string, source: string): boolean {
    return next.startsWith(source.trimEnd());
  }

  // A committed render stays on screen while the content only grows, so streamed appends never
  // flash the raw Markdown. Replacement content, or a change to the link or image policy, shows
  // the escaped plain text until the new render lands.
  const visibleRender = $derived.by(() => {
    if (rendered === undefined || rendered.html === '') return undefined;
    if (rendered.images !== images || rendered.links !== links) return undefined;
    return extendsSource(content, rendered.source) ? rendered : undefined;
  });
  const renderCurrent = $derived(visibleRender !== undefined && visibleRender.source === content);

  function commitRender(
    generation: number,
    renderEpoch: number,
    source: string,
    imagesPolicy: boolean,
    linksPolicy: boolean,
    html: string,
  ): void {
    if (renderEpoch !== epoch || generation <= committedGeneration) return;
    if (imagesPolicy !== images || linksPolicy !== links || !extendsSource(content, source)) return;
    committedGeneration = generation;
    rendered = {
      source,
      images: imagesPolicy,
      links: linksPolicy,
      html,
      segments: html
        ? segmentRenderedMarkdown(html, document, { images: imagesPolicy, links: linksPolicy })
        : [],
    };
  }

  $effect(() => {
    // Capture the snapshot and the policy for this run synchronously, so a change to any of the
    // three runs the effect again.
    const snapshot = content;
    const snapshotImages = images;
    const snapshotLinks = links;

    const appended =
      previousSnapshot !== undefined &&
      previousSnapshot.images === snapshotImages &&
      previousSnapshot.links === snapshotLinks &&
      extendsSource(snapshot, previousSnapshot.content);
    previousSnapshot = { content: snapshot, images: snapshotImages, links: snapshotLinks };
    if (!appended) {
      // Replacement content or a new policy: the previous presentation is never shown again, and
      // no render already in flight for it may land.
      epoch += 1;
      rendered = undefined;
    }
    const generation = ++latestGeneration;
    const renderEpoch = epoch;

    let cancelled = false;

    // Defer the rendering-pipeline import past first paint via a single
    // animation frame. requestAnimationFrame fires before the next paint,
    // which is a predictable upper bound (~16 ms at 60 Hz). We
    // intentionally do not use requestIdleCallback here: a chat UI is on
    // the user's critical visual path, and an idle deadline of even a
    // few hundred milliseconds would leave raw markdown source visible
    // for that whole window.
    //
    // Cancelling the rAF on cleanup also collapses rapid streaming
    // updates: each new content arrival cancels the pending frame and
    // schedules its own, so the renderer runs at most once per frame
    // even under per-token streaming. A render that has already started
    // is not cancelled: it may still commit, through the generation fence
    // in `commitRender`, so a stream whose renders outlast its token
    // interval still shows progress.
    const handle = requestAnimationFrame(() => {
      if (cancelled) return;
      const pipelinePromise = preloadMarkdownPipeline();
      if (!pipelinePromise) return;
      void pipelinePromise
        .then(async (pipeline) => {
          if (!pipeline) return undefined;
          try {
            const result = await pipeline.renderMarkdownWithMath(snapshot, {
              nodePlaceholders: true,
              stripLinks: !snapshotLinks,
            });
            commitRender(
              generation,
              renderEpoch,
              snapshot,
              snapshotImages,
              snapshotLinks,
              result.html,
            );
          } catch {
            // A failed render keeps whatever is on screen: the previous render while the content
            // only appends, the escaped plain text otherwise.
          }
          return undefined;
        })
        .catch(() => {
          // The loader settles to `undefined` on failure; nothing else here can reject.
        });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  });
</script>

{#snippet renderDefaultNode(node: ChatMarkdownNode)}
  <div class="message-content-wide" data-cinder-markdown-node={node.kind}>
    {#if node.kind === 'code-block'}
      <!-- Chat code is always copyable: a floating Copy named for its language, no header row,
           and a fade at the inline end while a long line continues. -->
      {#if node.language}
        <CodeBlock
          code={node.text}
          language={node.language}
          copyable
          copyFloating
          languageLabelVisible={false}
          scrollFadeVisible
        />
      {:else}
        <CodeBlock
          code={node.text}
          copyable
          copyFloating
          languageLabelVisible={false}
          scrollFadeVisible
        />
      {/if}
    {:else if node.kind === 'mermaid'}
      <CodeBlock code={node.text} language={node.language ?? 'mermaid'} />
    {:else if node.kind === 'table'}
      <MarkdownTableScroller html={node.html} />
    {:else}
      {#key node.html}
        {@html node.html}
      {/key}
    {/if}
  </div>
{/snippet}

{#snippet renderSegment(segment: MarkdownSegment)}
  {#if segment.kind === 'node'}
    {#if markdownNode}
      {@render markdownNode(segment.node, renderDefaultNode)}
    {:else}
      {@render renderDefaultNode(segment.node)}
    {/if}
  {:else if segment.kind === 'element'}
    <svelte:element this={segment.tag} {...segment.attributes}>
      {#each segment.children as child}
        {@render renderSegment(child)}
      {/each}
    </svelte:element>
  {:else}
    <!-- A newer render replaces this segment's markup in place while the block keeps its key.
         Keying on the markup replaces the nodes whole, so an `{@html}` change between two
         non-empty strings cannot leave the previous nodes behind. -->
    {#key segment.html}
      {@html segment.html}
    {/key}
  {/if}
{/snippet}

<!--
  `data-state` is `rendered` once the async pipeline has swapped in the formatted HTML for the
  current content, and `pending` while the raw-text fallback shows or while an earlier render
  stands in for an append that is still rendering. The swap replaces the DOM nodes, which
  collapses a selection made meanwhile, so a caller that selects text waits for `rendered` first.
-->
<div
  class={classNames('cinder-markdown-content message-content-preview', className)}
  data-state={renderCurrent ? 'rendered' : 'pending'}
  {...rest}
>
  {#if visibleRender}
    {#each visibleRender.segments as segment, index (`${segment.kind}:${index}`)}
      {@render renderSegment(segment)}
    {/each}
  {:else}
    <p>{content}</p>
  {/if}
</div>
