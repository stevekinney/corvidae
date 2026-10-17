<script lang="ts" module>
  export const title = 'Basic audio player';
  export const description =
    'Play, pause, and seek from the media controls. Only https, http, and blob sources load.';
</script>

<script lang="ts">
  import { AudioPlayer } from '@lostgradient/cinder';
</script>

<AudioPlayer src="https://example.com/media/briefing.mp3" label="Daily briefing" />
