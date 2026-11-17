<script lang="ts" module>
  export type { LocaleProviderProps, TextDirection } from './locale-provider.types.ts';
</script>

<script lang="ts">
  import {
    getLocaleContext,
    setLocaleContext,
    type LocaleContext,
  } from '@lostgradient/foundation/_internal/locale-context.ts';
  import type { LocaleProviderProps } from './locale-provider.types.ts';

  let { locale, direction, children }: LocaleProviderProps = $props();
  const parentContext = getLocaleContext();

  const context: LocaleContext = {
    get locale() {
      return locale ?? parentContext?.locale;
    },
    get direction() {
      return direction ?? parentContext?.direction;
    },
  };

  setLocaleContext(context);
</script>

{@render children?.()}
