<script lang="ts">
  import Horizontal from './virtual-list/horizontal.svelte';
  import HorizontalRtl from './virtual-list/horizontal-rtl.svelte';
  import HorizontalStickyHeaders from './virtual-list/horizontal-sticky-headers.svelte';
  import StickyHeaders from './virtual-list/sticky-headers.svelte';
  import TenThousand from './virtual-list/ten-thousand.svelte';
</script>

<div id="example-mount-ten-thousand"><TenThousand /></div>
<div id="example-mount-horizontal"><Horizontal /></div>
<div id="example-mount-horizontal-rtl"><HorizontalRtl /></div>
<div id="example-mount-sticky-headers"><StickyHeaders /></div>
<div id="example-mount-horizontal-sticky-headers"><HorizontalStickyHeaders /></div>
