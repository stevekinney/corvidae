<script lang="ts" module>
  export type { CodeLocationProps } from './code-location.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';

  import type { CodeLocationProps } from './code-location.types.ts';

  let {
    file,
    line,
    column,
    class: customClassName,
    children,
    ...rest
  }: CodeLocationProps = $props();
  const fileSegments = $derived(file.split(/(?<=[/\\.-])/u));
</script>

<span class={classNames('cinder-code-location', customClassName)} {...rest}
  ><code
    >{#each fileSegments as segment, index (index)}<span class="cinder-code-location__segment"
        >{segment}{#if index === fileSegments.length - 1 && line !== undefined}<span
            class="cinder-code-location__position"
            >:{line}{#if column !== undefined}:{column}{/if}</span
          >{/if}</span
      >{#if index < fileSegments.length - 1}<wbr />{/if}{/each}</code
  >{#if children}{@render children()}{/if}</span
>
