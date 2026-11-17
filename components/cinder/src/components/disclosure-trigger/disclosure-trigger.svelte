<script lang="ts" module>
  /**
   * @cinder
   * @category action
   * @status stable
   * @purpose The one disclosure trigger: a chevron that turns down when its region opens, at one size, colour and label weight.
   * @tag disclosure
   * @tag toggle
   * @useWhen Words show and hide a region elsewhere in the layout, such as a step group's calls or an error's details.
   * @useWhen Several kinds of folded content on one surface must read as one control.
   * @avoidWhen The trigger and its region are one self-contained block — use collapsible.
   * @avoidWhen Several sections where opening one closes the others — use accordion.
   * @related collapsible
   * @related accordion
   */
  export type { DisclosureTriggerProps } from './disclosure-trigger.types.ts';
</script>

<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  import { classNames } from '../../utilities/class-names.ts';
  import type { DisclosureTriggerProps } from './disclosure-trigger.types.ts';

  let { open, controls, children, class: className, ...rest }: DisclosureTriggerProps = $props();
</script>

<button
  {...rest}
  type="button"
  class={classNames('cinder-disclosure-trigger', className)}
  aria-expanded={open}
  aria-controls={controls}
  data-cinder-open={open ? '' : undefined}
>
  <ChevronRight class="cinder-disclosure-trigger__chevron" aria-hidden="true" />
  <span class="cinder-disclosure-trigger__label">{@render children()}</span>
</button>
