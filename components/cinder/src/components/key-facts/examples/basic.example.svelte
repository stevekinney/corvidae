<script lang="ts" module>
  export const title = 'Facts with icons';
  export const description =
    'Each fact is an icon and a value, separated from the next by space. The row wraps between facts, never inside one, and draws no separator glyph.';
</script>

<script lang="ts">
  import { KeyFacts } from '@lostgradient/cinder';
  import MapPin from '@lucide/svelte/icons/map-pin';
  import Martini from '@lucide/svelte/icons/martini';
  import DollarSign from '@lucide/svelte/icons/dollar-sign';
</script>

{#snippet venue()}<Martini size={14} />{/snippet}
{#snippet place()}<MapPin size={14} />{/snippet}
{#snippet price()}<DollarSign size={14} />{/snippet}

<KeyFacts
  label="Details"
  items={[
    { icon: venue, label: 'Kind', value: 'Cocktail bar' },
    { icon: place, label: 'Neighborhood', value: 'LoDo' },
    { icon: price, label: 'Price', value: '$$' },
  ]}
/>
