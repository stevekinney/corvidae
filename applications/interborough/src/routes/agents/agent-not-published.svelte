<script lang="ts">
  /**
   * The one badge an agent can carry: it is not published. A published agent is the normal state
   * and says nothing. The tooltip says what the badge costs the person, that no chat can be started.
   * The badge sits in a button, the one element a Tooltip anchors to that takes focus, so the hint
   * reaches a keyboard as well as a pointer; the button does nothing when pressed.
   */
  import { Badge, Tooltip } from '@lostgradient/cinder';

  import { AGENTS_COPY } from '../../app/copy.ts';
</script>

<Tooltip text={AGENTS_COPY.notPublishedHint} placement="bottom">
  <button type="button" class="ib-agent-state" data-testid="agent-not-published">
    <Badge variant="warning" size="sm">{AGENTS_COPY.notPublished}</Badge>
  </button>
</Tooltip>
