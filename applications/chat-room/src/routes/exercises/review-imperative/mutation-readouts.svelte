<script lang="ts">
  let {
    threadCount,
    lastCall,
    lastReturn,
    anchorsJson,
    probeJson,
    selectionJson,
    selectionAtCall,
    events,
    readonlyThreadCount,
    readonlyAnchorsJson,
    readonlyEvents,
    readonlyCommentBodies,
    commentBodies,
    readonlyValueLength,
    valueLength,
  }: {
    threadCount: number;
    lastCall: string;
    lastReturn: string;
    anchorsJson: string;
    probeJson: string;
    selectionJson: string;
    selectionAtCall: string;
    events: string[];
    readonlyThreadCount: number;
    readonlyAnchorsJson: string;
    readonlyEvents: string[];
    readonlyCommentBodies: string;
    commentBodies: string;
    readonlyValueLength: number;
    valueLength: number;
  } = $props();
</script>

<section
  aria-labelledby="readouts-heading"
  style="font-family: ui-monospace, monospace; font-size: 0.8rem; display: grid; gap: 0.25rem;"
>
  <h2 id="readouts-heading" style="font-family: inherit;">Readouts</h2>
  <p data-testid="thread-count" style="margin: 0;">threads: {threadCount}</p>
  <p data-testid="last-call" style="margin: 0;">last call: {lastCall}</p>
  <p data-testid="last-return" style="margin: 0;">last return: {lastReturn}</p>
  <p data-testid="anchors-json" style="margin: 0; word-break: break-all;">{anchorsJson}</p>
  <p data-testid="probe-json" style="margin: 0; word-break: break-all;">{probeJson}</p>
  <p data-testid="selection-json" style="margin: 0; word-break: break-all;">{selectionJson}</p>
  <p data-testid="selection-at-call" style="margin: 0; word-break: break-all;">
    {selectionAtCall}
  </p>
  <p data-testid="events" style="margin: 0; word-break: break-all;">{events.join('|')}</p>
  <p data-testid="ro-thread-count" style="margin: 0;">readonly threads: {readonlyThreadCount}</p>
  <p data-testid="ro-anchors-json" style="margin: 0; word-break: break-all;">
    {readonlyAnchorsJson}
  </p>
  <p data-testid="ro-events" style="margin: 0; word-break: break-all;">
    {readonlyEvents.join('|')}
  </p>
  <p data-testid="ro-comment-bodies" style="margin: 0; word-break: break-all;">
    {readonlyCommentBodies}
  </p>
  <p data-testid="comment-bodies" style="margin: 0; word-break: break-all;">{commentBodies}</p>
  <p data-testid="ro-value-length" style="margin: 0;">
    readonly value length: {readonlyValueLength}
  </p>
  <p data-testid="value-length" style="margin: 0;">value length: {valueLength}</p>
</section>
