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
  const location = $derived(
    `${file}${line === undefined ? '' : `:${line}${column === undefined ? '' : `:${column}`}`}`,
  );
</script>

<span class={classNames('cinder-code-location', customClassName)} {...rest}
  ><code>{location}</code>{#if children}{@render children()}{/if}</span
>
