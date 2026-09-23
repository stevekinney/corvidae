<script lang="ts">
  import AdaptiveOverscan from './virtual-list/adaptive-overscan.svelte';
  import AdaptiveOverscanDynamicSize from './virtual-list/adaptive-overscan-dynamic-size.svelte';
  import Horizontal from './virtual-list/horizontal.svelte';
  import HorizontalRtl from './virtual-list/horizontal-rtl.svelte';
  import HorizontalStickyHeaderClip from './virtual-list/horizontal-sticky-header-clip.svelte';
  import HorizontalStickyHeaders from './virtual-list/horizontal-sticky-headers.svelte';
  import StickyHeaders from './virtual-list/sticky-headers.svelte';
  import StickyHeadersSmoothScroll from './virtual-list/sticky-headers-smooth-scroll.svelte';
  import TenThousand from './virtual-list/ten-thousand.svelte';
</script>

<div id="example-mount-ten-thousand"><TenThousand /></div>
<div id="example-mount-horizontal"><Horizontal /></div>
<div id="example-mount-horizontal-rtl"><HorizontalRtl /></div>
<div id="example-mount-sticky-headers"><StickyHeaders /></div>
<div id="example-mount-sticky-headers-smooth-scroll"><StickyHeadersSmoothScroll /></div>
<div id="example-mount-horizontal-sticky-headers"><HorizontalStickyHeaders /></div>
<div id="example-mount-adaptive-overscan"><AdaptiveOverscan /></div>
<div id="example-mount-adaptive-overscan-dynamic-size"><AdaptiveOverscanDynamicSize /></div>
<div id="example-mount-horizontal-sticky-header-clip"><HorizontalStickyHeaderClip /></div>
