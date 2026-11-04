<script lang="ts" module>
  /**
   * @cinder
   * @category typography
   * @status stable
   * @purpose Run of text in one of the typography variants h1 to h5, caption, or body that inherits its color from its container.
   * @tag typography
   * @tag text
   * @useWhen Rendering a heading, paragraph, or caption in the design system's type scale.
   * @useWhen Overriding the rendered element while keeping a variant's visual style.
   * @avoidWhen Introducing a page section with an eyebrow, description, or actions — use section-heading instead.
   * @avoidWhen Rendering Markdown content — compose the Markdown renderer instead.
   * @related section-heading, label
   */
  export type { TextElement, TextProps, TextVariant } from './text.types.ts';
</script>

<script lang="ts">
  import type { Attachment } from 'svelte/attachments';

  import { classNames } from '../../utilities/class-names.ts';

  import type { TextElement, TextProps, TextVariant } from './text.types.ts';

  const DEFAULT_TAIL_LENGTH = 4;

  let {
    variant = 'body',
    as,
    class: className,
    children,
    clamp,
    expanded = $bindable(false),
    actions,
    truncate,
    text,
    tailLength = DEFAULT_TAIL_LENGTH,
    ...rest
  }: TextProps = $props();

  const defaultElements = {
    h1: 'h1',
    h2: 'h2',
    h3: 'h3',
    h4: 'h4',
    h5: 'h5',
    caption: 'p',
    body: 'p',
  } as const satisfies Record<TextVariant, TextElement>;

  const element = $derived(as ?? defaultElements[variant]);
  const generatedId = $props.id();

  const clampLines = $derived(
    typeof clamp === 'number' && Number.isFinite(clamp) && clamp >= 1
      ? Math.floor(clamp)
      : undefined,
  );
  const isMiddle = $derived(truncate === 'middle' && typeof text === 'string');
  const rootId = $derived(typeof rest.id === 'string' && rest.id !== '' ? rest.id : generatedId);

  // Whether the clamped run is actually cut off. It is measured while the run is closed (an open run
  // has nothing to compare against) and kept while it is open, so "Show less" stays offered.
  let cutOff = $state(false);

  const measureClamp: Attachment<HTMLElement> = (node) => {
    if (clampLines === undefined || expanded) return;
    const measure = (): void => {
      cutOff = node.scrollHeight > node.clientHeight;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  };

  // The tail is counted in characters a reader sees, so a surrogate pair is never split.
  const middleParts = $derived.by(() => {
    if (!isMiddle || text === undefined) return undefined;
    const characters = Array.from(text);
    const tailSize = Math.max(0, Math.min(characters.length, Math.floor(tailLength)));
    return {
      head: characters.slice(0, characters.length - tailSize).join(''),
      tail: characters.slice(characters.length - tailSize).join(''),
    };
  });
</script>

{#if middleParts !== undefined}
  <svelte:element
    this={element}
    title={text}
    {...rest}
    class={classNames('cinder-text', className)}
    data-cinder-variant={variant}
    data-cinder-truncate="middle"
  >
    <span class="cinder-text__head">{middleParts.head}</span><span class="cinder-text__tail"
      >{middleParts.tail}</span
    >
  </svelte:element>
{:else if clampLines !== undefined}
  <svelte:element
    this={element}
    {...rest}
    id={rootId}
    class={classNames('cinder-text', className)}
    data-cinder-variant={variant}
    data-cinder-clamp={expanded ? undefined : ''}
    style:--_cinder-text-lines={clampLines}
    {@attach measureClamp}
  >
    {@render children?.()}
  </svelte:element>
  {#if cutOff || expanded || actions}
    <div class="cinder-text__footer">
      {#if cutOff || expanded}
        <button
          type="button"
          class="cinder-text__toggle"
          aria-expanded={expanded}
          aria-controls={rootId}
          onclick={() => (expanded = !expanded)}
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      {/if}
      {#if actions}
        <span class="cinder-text__actions">{@render actions()}</span>
      {/if}
    </div>
  {/if}
{:else}
  <svelte:element
    this={element}
    {...rest}
    class={classNames('cinder-text', className)}
    data-cinder-variant={variant}
  >
    {@render children?.()}
  </svelte:element>
{/if}
