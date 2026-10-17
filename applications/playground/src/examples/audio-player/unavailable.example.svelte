<script lang="ts" module>
  export const title = 'Unavailable source';
  export const description =
    'A source whose scheme is not https, http, or blob never loads and renders the unavailable controls.';
</script>

<script lang="ts">
  import { AudioPlayer } from '@lostgradient/cinder';
</script>

<AudioPlayer src="data:text/html,unsupported" label="Blocked source" />
