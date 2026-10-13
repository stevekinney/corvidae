<script lang="ts" module>
  export const title = 'Basic message';
  export const description = 'A single assistant message with a timestamp.';
  // Featured so the Overview stage previews the exact message the README's usage
  // snippet documents; the stage shows this file's source, so the two agree.
  export const featured = true;
</script>

<script lang="ts">
  import { Message } from '@lostgradient/cinder';
</script>

<Message role="assistant" timestamp="10:00">How can I help?</Message>
