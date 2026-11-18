<script lang="ts" module>
  export type { TabListProps } from './tab-list.types.ts';
</script>

<script lang="ts">
  import type { TabListProps } from './tab-list.types.ts';

  import { getTabsContext } from '../tabs/tabs-context.ts';
  import { overflowFadeEdges } from '../../utilities/attachments.ts';
  import { classNames } from '../../utilities/class-names.ts';

  let { label, ariaLabelledby, class: className, children, ...rest }: TabListProps = $props();

  const tabs = getTabsContext();
</script>

<div
  {...rest}
  role="tablist"
  hidden={tabs.collapsed}
  class={classNames(
    'cinder-tab-list',
    tabs.orientation === 'horizontal' && 'cinder-_scroll-fade-inline-end',
    className,
  )}
  data-cinder-orientation={tabs.orientation}
  aria-label={label}
  aria-labelledby={ariaLabelledby}
  aria-orientation={tabs.orientation}
  {@attach tabs.orientation === 'horizontal' ? overflowFadeEdges('inline') : undefined}
>
  {@render children()}
</div>
