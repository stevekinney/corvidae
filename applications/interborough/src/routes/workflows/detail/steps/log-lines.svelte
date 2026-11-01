<script lang="ts">
  /**
   * Log lines in the order they were logged: when, how serious, what was said, and the details the
   * line carried. Lines are plain text on the page's own surface, with no box around each, and a
   * long message or an unbroken value wraps instead of widening the page.
   */
  import { Badge, type BadgeVariant } from '@lostgradient/cinder';

  import type { RunLogLine } from './step-logs.ts';

  interface LogLinesProps {
    readonly lines: readonly RunLogLine[];
    /** The list's accessible name. */
    readonly label: string;
  }

  let { lines, label }: LogLinesProps = $props();

  const LEVEL_VARIANT: Readonly<Record<RunLogLine['level'], BadgeVariant>> = {
    debug: 'neutral',
    info: 'info',
    warn: 'warning',
    error: 'danger',
  };

  /** The clock time of a line, to the millisecond: lines of one run are often milliseconds apart. */
  function clockTime(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  }

  function attributesText(attributes: Record<string, unknown> | undefined): string | undefined {
    if (attributes === undefined || Object.keys(attributes).length === 0) return undefined;
    return JSON.stringify(attributes);
  }
</script>

<ol class="ib-log-lines" aria-label={label}>
  {#each lines as line (line.sequence)}
    {@const attributes = attributesText(line.attributes)}
    <li class="ib-log-lines__line" data-level={line.level}>
      <span class="ib-log-lines__meta">
        <time class="ib-log-lines__time" datetime={new Date(line.timestamp).toISOString()}
          >{clockTime(line.timestamp)}</time
        >
        <Badge variant={LEVEL_VARIANT[line.level]} size="xs">{line.level}</Badge>
      </span>
      <span class="ib-log-lines__message">{line.message}</span>
      {#if attributes !== undefined}
        <code class="ib-log-lines__attributes">{attributes}</code>
      {/if}
    </li>
  {/each}
</ol>

<style>
  .ib-log-lines {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
  }

  .ib-log-lines__line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-1) var(--cinder-space-2);
    min-width: 0;
    font-size: var(--cinder-text-xs);
  }

  .ib-log-lines__meta {
    display: inline-flex;
    align-items: baseline;
    gap: var(--cinder-space-2);
  }

  .ib-log-lines__time {
    font-family: var(--cinder-font-mono);
    color: var(--cinder-text-subtle);
    white-space: nowrap;
  }

  .ib-log-lines__message {
    min-width: 0;
    flex: 1 1 12rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .ib-log-lines__attributes {
    flex-basis: 100%;
    min-width: 0;
    font-family: var(--cinder-font-mono);
    color: var(--cinder-text-subtle);
    overflow-wrap: anywhere;
  }
</style>
