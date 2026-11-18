<script lang="ts" module>
  export const title = 'Basic video player';
  export const description =
    'Play, pause, and seek from the media controls. Only https, http, and blob sources load.';
</script>

<script lang="ts">
  import { VideoPlayer } from '@lostgradient/cinder';
</script>

<VideoPlayer
  src="https://example.com/media/intro.mp4"
  label="Product introduction"
  poster="https://example.com/media/intro.jpg"
/>
