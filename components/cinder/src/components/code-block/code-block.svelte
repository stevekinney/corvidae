<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status stable
   * @purpose Block container for multi-line source code with optional syntax highlighting and a copy-to-clipboard control.
   * @tag code
   * @tag snippet
   * @useWhen Displaying a multi-line code sample or terminal transcript inside documentation or chat.
   * @useWhen Letting the reader copy a snippet to the clipboard via the copyable prop.
   * @avoidWhen Annotating a single inline keystroke or shortcut — use kbd instead.
   * @avoidWhen Rendering rich prose that happens to include code — embed it in markdown instead.
   * @related kbd, copy-button
   */
  export type { CodeBlockProps } from './code-block.types.ts';
</script>

<script lang="ts">
  import Info from '@lucide/svelte/icons/info';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import type { Attachment } from 'svelte/attachments';
  import { getCodeHighlighterContext } from '../../_internal/code-highlighter-context.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { devWarn } from '../../utilities/dev-warn.ts';
  import { overflowFadeEdges } from '../../utilities/attachments.ts';
  import CopyButton from '../copy-button/copy-button.svelte';
  import {
    annotationToneClass,
    decorateHighlightedLines,
    lineToneClass,
  } from './code-block-lines.ts';
  import type { CodeBlockAnnotation, CodeBlockProps } from './code-block.types.ts';

  let {
    code,
    language,
    highlight,
    highlighter,
    copyable = false,
    languageLabelVisible = true,
    scrollFadeVisible = false,
    lineNumbers = false,
    annotations,
    wrap = false,
    class: className,
  }: CodeBlockProps = $props();

  const noopScrollFadeAttachment: Attachment<HTMLElement> = () => {};
  const viewportScrollFadeAttachment = overflowFadeEdges('inline');

  // CodeBlock imports no highlighter of its own. It highlights with its
  // `highlighter` prop, else with the one an ancestor published through
  // `setCodeHighlighterContext`, else not at all. Context is read once, during
  // initialization, as Svelte requires.
  const contextHighlighter = getCodeHighlighterContext();

  let highlighted = $state<string | null>(null);

  // Numbered lines and notes need one element per line. Plain code is split here; highlighted
  // code is decorated after it renders (see `code-block-lines.ts`). A highlighter that draws no
  // line elements leaves `lined` false, and the block shows the plain rendering instead.
  const hasLineFeatures = $derived(lineNumbers || (annotations?.length ?? 0) > 0);
  const codeLines = $derived(
    hasLineFeatures ? (code.endsWith('\n') ? code.slice(0, -1) : code).split('\n') : [],
  );
  // Digits of the largest line number, which sizes the gutter.
  const gutterDigits = $derived(String(Math.max(1, codeLines.length)).length);
  let lined = $state(true);
  const notesByLine = $derived.by(() => {
    const byLine = new Map<number, CodeBlockAnnotation[]>();
    for (const annotation of annotations ?? []) {
      const line = Math.trunc(annotation.line);
      byLine.set(line, [...(byLine.get(line) ?? []), annotation]);
    }
    return byLine;
  });

  // Two-phase render contract: the server (and the first client paint) emits
  // the plain `<pre><code>` fallback because `$effect` never runs during SSR.
  // The effect below — client-only by definition — enhances the block to the
  // highlighted HTML once the highlighter resolves. The outer viewport stays
  // mounted across both phases so syntax colorization cannot move surrounding
  // layout.
  $effect(() => {
    // `highlight={false}` is an absolute off switch: it disables ALL
    // highlighting — including an explicit `highlighter` prop or a context
    // highlighter. The block stays the escaped plain fallback. (Default when
    // unset: highlight whenever `language` is set and a highlighter resolves.)
    const resolvedHighlighter = highlighter ?? contextHighlighter;
    if (highlight === false || !language || resolvedHighlighter === undefined) {
      highlighted = null;
      return;
    }

    // Snapshot the inputs this run highlights so a later `code`/`language`/
    // `highlighter` change can't let a stale (and `{@html}`-trusted) result
    // overwrite a newer state. The cleanup flips `cancelled`, which gates
    // EVERY assignment below.
    const pendingCode = code;
    const pendingLanguage = language;

    // Drop any stale highlighted output before starting a new request so a
    // change can't leave the previous render visible while the new request
    // is in flight.
    highlighted = null;
    let cancelled = false;

    // The highlighter may throw synchronously OR reject — wrap the call in one
    // async IIFE so both failure modes hit the same `catch`.
    void (async () => {
      try {
        const html = await resolvedHighlighter(pendingCode, pendingLanguage);
        if (!cancelled) {
          highlighted = html === '' ? null : html;
          lined = true;
        }
      } catch (error) {
        if (!cancelled) highlighted = null;
        // Surface to the developer without breaking the graceful fallback.
        // Never log the code itself — a code block can contain secrets. Log
        // the language and the error class/message only.
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        devWarn(`[cinder/CodeBlock] highlight failed for language "${pendingLanguage}":`, detail);
      }
    })();

    return () => {
      cancelled = true;
    };
  });
</script>

{#snippet note(annotation: CodeBlockAnnotation)}
  {@const tone = annotation.tone ?? 'danger'}
  <!-- A `<small>`, not a `<span>`: the stylesheet that keeps Shiki's own backgrounds and colors off
       the code targets every span in the block. -->
  <small class={classNames('cinder-code-block__annotation', annotationToneClass(tone))} role="note">
    {#if tone === 'info'}
      <Info size={14} aria-hidden="true" />
    {:else}
      <TriangleAlert size={14} aria-hidden="true" />
    {/if}
    {annotation.message}
  </small>
{/snippet}

{#snippet plainCode()}
  {#if hasLineFeatures}
    <pre class="cinder-code-block__pre"><code class="cinder-code-block__code"
        >{#each codeLines as text, index (index)}{@const notes =
            notesByLine.get(index + 1) ?? []}<span
            class={classNames(
              'cinder-code-block__line',
              notes[0] && lineToneClass(notes[0].tone ?? 'danger'),
            )}>{text}</span
          >{#each notes as annotation, noteIndex (noteIndex)}{@render note(
              annotation,
            )}{/each}{/each}</code
      ></pre>
  {:else}
    <pre class="cinder-code-block__pre"><code class="cinder-code-block__code">{code}</code></pre>
  {/if}
{/snippet}

<div
  class={classNames(
    'cinder-code-block',
    lineNumbers && 'cinder-code-block--numbered',
    wrap && 'cinder-code-block--wrap',
    className,
  )}
  style:--_cinder-code-block-digits={hasLineFeatures ? gutterDigits : undefined}
>
  {#if (language && languageLabelVisible) || copyable}
    <div class="cinder-code-block__meta">
      {#if language && languageLabelVisible}
        <span class="cinder-code-block__language">{language}</span>
      {/if}
      {#if copyable}
        <CopyButton
          value={code}
          class="cinder-code-block__copy"
          label="Copy code"
          copiedLabel="Code copied"
          iconOnly={true}
        />
      {/if}
    </div>
  {/if}
  <!-- One stable, focusable scroll viewport is shared by plain, highlighted,
       and fallback states. Keep tabindex unconditional so overflowing snippets
       are keyboard-scrollable before measurement. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -- keyboard scrolling is intentional for overflow content. -->
  <div
    class={classNames(
      'cinder-code-block__viewport',
      scrollFadeVisible && 'cinder-_scroll-fade-inline-start cinder-_scroll-fade-inline-end',
    )}
    tabindex="0"
    {@attach scrollFadeVisible ? viewportScrollFadeAttachment : noopScrollFadeAttachment}
  >
    <!-- The svelte:boundary catches errors thrown during render of {@html highlighted}
         (e.g. a malformed HTML string that breaks Svelte's reconciliation). Sync/async
         errors from the highlighter ITSELF are caught above; this is the secondary net. -->
    <!-- `{@html}` reconciliation across string→string transitions strands the
         previous DOM nodes when they're emitted as direct children of an
         `{#if}` branch (Svelte 5: the prior nodes share the same parent and
         no anchor scopes them). Wrap the `{@html}` output in a stable
         container `<div>` so the previous render is contained inside an
         element Svelte can replace in place. -->
    <svelte:boundary>
      {#if highlighted !== null && (lined || !hasLineFeatures)}
        {#key highlighted}
          <div
            class="cinder-code-block__highlighted"
            {@attach hasLineFeatures
              ? decorateHighlightedLines(annotations, (found) => (lined = found))
              : noopScrollFadeAttachment}
          >
            {@html highlighted}
          </div>
        {/key}
      {:else}
        {@render plainCode()}
      {/if}
      {#snippet failed()}
        {@render plainCode()}
      {/snippet}
    </svelte:boundary>
  </div>
</div>
