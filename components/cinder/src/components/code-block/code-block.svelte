<script lang="ts" module>
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
  import { IDENTIFIER_ACRONYMS } from '../../utilities/humanize-identifier.ts';
  import { useResizeObserver } from '../../utilities/use-resize-observer.svelte.ts';
  import CopyButton from '../copy-button/copy-button.svelte';
  import {
    allowBreaksAtPunctuation,
    annotationToneClass,
    splitWords,
    decorateHighlightedLines,
    hangWrappedLines,
    keepFlagsWhole,
    leadingIndent,
    markNumericTokens,
    splitFlags,
    lineToneClass,
  } from './code-block-lines.ts';
  import type { CodeBlockAnnotation, CodeBlockProps } from './code-block.types.ts';

  let {
    code,
    language,
    highlight,
    highlighter,
    copyable = false,
    copyFloating,
    copyLabel,
    languageLabelVisible = true,
    streaming = false,
    streamingLabel = 'Writing…',
    scrollFadeVisible = false,
    lineNumbers = false,
    annotations,
    wrap = false,
    class: className,
  }: CodeBlockProps = $props();

  const noopScrollFadeAttachment: Attachment<HTMLElement> = () => {};
  const viewportScrollFadeAttachment = overflowFadeEdges('inline');
  const reserveFloatingMeta = useResizeObserver((entries) => {
    const meta = entries.at(-1)?.target;
    const codeBlock = meta?.parentElement;
    if (!(meta instanceof HTMLElement) || !(codeBlock instanceof HTMLElement)) return;
    codeBlock.style.setProperty(
      '--_cinder-code-block-float-meta-width',
      `${Math.ceil(meta.getBoundingClientRect().width)}px`,
    );
  });

  // CodeBlock imports no highlighter of its own. It highlights with its
  // `highlighter` prop, else with the one an ancestor published through
  // `setCodeHighlighterContext`, else not at all. Context is read once, during
  // initialization, as Svelte requires.
  const contextHighlighter = getCodeHighlighterContext();

  let highlighted = $state<string | null>(null);
  // Expose the asynchronous rendering phase so capture harnesses can wait for a settled visual
  // state instead of guessing with a timer. `plain` is a deliberate non-highlighted result;
  // `fallback` means highlighting was requested but unavailable or rejected.
  let highlightState = $state<'plain' | 'pending' | 'ready' | 'fallback'>('plain');

  // Code that is still arriving cannot be copied yet: the copy action returns with the last token.
  const copyVisible = $derived(copyable && !streaming);
  // The copy action names what it copies, so a reader of several blocks hears which one. The
  // page's `copyLabel` wins; otherwise the language is named, an acronym such as JSON or SQL in its
  // canonical spelling.
  const copyName = $derived(
    copyLabel ??
      (language
        ? `Copy ${
            IDENTIFIER_ACRONYMS.find(
              (acronym) => acronym.toLowerCase() === language.toLowerCase(),
            ) ?? language
          } code`
        : 'Copy code'),
  );
  const languageShown = $derived(Boolean(language && languageLabelVisible));
  const metaVisible = $derived(languageShown || copyVisible || streaming);
  // With no language label to share a row with, the copy action floats over the code's corner
  // instead of spending a header row on one icon. `copyFloating` states either choice outright.
  const floatingMeta = $derived(metaVisible && (copyFloating ?? (copyable && !languageShown)));

  // Numbered lines and notes need one element per line. Plain code is split here; highlighted
  // code is decorated after it renders (see `code-block-lines.ts`). A highlighter that draws no
  // line elements leaves `lined` false, and the block shows the plain rendering instead.
  const needsLines = $derived(lineNumbers || (annotations?.length ?? 0) > 0);
  // A wrapping block hangs the continuation of a long line, which takes one element per line. While
  // streaming it stays one run of text, so the caret can follow the last character.
  const hasLineFeatures = $derived(needsLines || (wrap && !streaming));
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
    // Streaming code stays plain, so its caret can sit after the final character; it highlights
    // once the last token has arrived.
    if (highlight === false || streaming || !language || resolvedHighlighter === undefined) {
      highlighted = null;
      highlightState = 'plain';
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
    highlightState = 'pending';
    let cancelled = false;

    // The highlighter may throw synchronously OR reject — wrap the call in one
    // async IIFE so both failure modes hit the same `catch`.
    void (async () => {
      try {
        const html = await resolvedHighlighter(pendingCode, pendingLanguage);
        if (!cancelled) {
          highlighted = html === '' ? null : html;
          highlightState = html === '' ? 'fallback' : 'ready';
          lined = true;
        }
      } catch (error) {
        if (!cancelled) {
          highlighted = null;
          highlightState = 'fallback';
        }
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

<!-- A wrapping block's text. A word with a slash, dot, colon or hyphen in it is a box of its own, with
     a break opportunity after each of them: it moves to the next row whole when it fits one, and
     breaks at a slash only when it is wider than a row. `<wbr>` is no character, so what is shown
     and copied is the code as written. No whitespace around the pieces: inside a `pre` it would be
     text. -->
{#snippet broken(
  text: string,
)}{#each splitWords(text) as run, runIndex (runIndex)}{#if run.pieces.length > 1}<span
        class="cinder-code-block__word"
        >{#each run.pieces as piece, index (index)}{piece}{#if index < run.pieces.length - 1}<wbr
            />{/if}{/each}</span
      >{:else}{run.text}{/if}{/each}{/snippet}

{#snippet plainCode()}
  {#if hasLineFeatures}
    <pre class="cinder-code-block__pre"><code class="cinder-code-block__code"
        >{#each codeLines as text, index (index)}{@const notes =
            notesByLine.get(index + 1) ?? []}<span
            class={classNames(
              'cinder-code-block__line',
              notes[0] && lineToneClass(notes[0].tone ?? 'danger'),
            )}
            style:--_cinder-code-block-indent-spaces={wrap ? leadingIndent(text).spaces : undefined}
            style:--_cinder-code-block-indent-tabs={wrap ? leadingIndent(text).tabs : undefined}
            >{#if wrap}{#each splitFlags(text) as run, runIndex (runIndex)}{#if run.flag}<span
                    class="cinder-code-block__flag">{run.text}</span
                  >{:else}{@render broken(run.text)}{/if}{/each}{:else}{text}{/if}</span
          >{#each notes as annotation, noteIndex (noteIndex)}{@render note(
              annotation,
            )}{/each}{/each}{#if streaming}{@render caret()}{/if}</code
      ></pre>
  {:else}
    <pre class="cinder-code-block__pre"><code class="cinder-code-block__code"
        >{#if wrap}{#each splitFlags(code) as run, index (index)}{#if run.flag}<span
                class="cinder-code-block__flag">{run.text}</span
              >{:else}{@render broken(
                run.text,
              )}{/if}{/each}{:else}{code}{/if}{#if streaming}{@render caret()}{/if}</code
      ></pre>
  {/if}
{/snippet}

<!-- While streaming, a caret follows the final character inside the code itself. It is drawn, not
     text, so it is never copied or read out. -->
{#snippet caret()}<span class="cinder-code-block__caret" aria-hidden="true"></span>{/snippet}

<div
  class={classNames(
    'cinder-code-block',
    lineNumbers && 'cinder-code-block--numbered',
    wrap && 'cinder-code-block--wrap',
    floatingMeta && 'cinder-code-block--floating-meta',
    streaming && 'cinder-code-block--streaming',
    className,
  )}
  data-cinder-highlight-state={highlightState}
  style:--_cinder-code-block-digits={hasLineFeatures ? gutterDigits : undefined}
  aria-busy={streaming ? 'true' : undefined}
>
  {#if metaVisible}
    <div class="cinder-code-block__meta" {@attach floatingMeta ? reserveFloatingMeta : undefined}>
      {#if language && languageLabelVisible}
        <span class="cinder-code-block__language">{language}</span>
      {/if}
      {#if streaming}
        <span class="cinder-code-block__status">{streamingLabel}</span>
      {:else if copyVisible}
        <CopyButton
          value={code}
          class="cinder-code-block__copy"
          label={copyName}
          copiedLabel="Code copied"
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
      {#if highlighted !== null && (lined || !needsLines)}
        {#key highlighted}
          <div
            class="cinder-code-block__highlighted"
            {@attach hasLineFeatures
              ? decorateHighlightedLines(annotations, (found) => (lined = found))
              : noopScrollFadeAttachment}
            {@attach markNumericTokens}
            {@attach wrap ? keepFlagsWhole : noopScrollFadeAttachment}
            {@attach wrap ? hangWrappedLines : noopScrollFadeAttachment}
            {@attach wrap ? allowBreaksAtPunctuation : noopScrollFadeAttachment}
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
