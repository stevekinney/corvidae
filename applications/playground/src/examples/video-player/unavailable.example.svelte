<script lang="ts" module>
  export const title = 'Unavailable source';
  export const description =
    'A source whose scheme is not https, http, or blob never loads and renders the unavailable controls.';
</script>

<script lang="ts">
  import { VideoPlayer } from '@lostgradient/cinder';
</script>

<VideoPlayer src="data:text/html,unsupported" label="Blocked source" />
