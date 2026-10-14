<script lang="ts">
  /*
   * One color mode's role-ordered proposal (COR-263): per role, the original authored value
   * in its own space beside the proposed OKLCH value, with the lock and the explicit-include
   * controls. A stacked list, never a wide table, so it reflows at narrow widths.
   */
  import { Checkbox } from '@lostgradient/cinder';

  import type { PaletteColorMode, RoleProposal } from './theme-palette-proposal.ts';

  type Props = {
    roles: readonly RoleProposal[];
    mode: PaletteColorMode;
    locked: ReadonlySet<string>;
    included: ReadonlySet<string>;
    onLock: (key: string, on: boolean) => void;
    onInclude: (key: string, on: boolean) => void;
  };
  let { roles, mode, locked, included, onLock, onInclude }: Props = $props();

  const ordered = $derived(roles.toSorted((a, b) => Number(b.anchor) - Number(a.anchor)));
  const SKIPPED = {
    locked: 'Locked: kept as it is',
    alias: 'Linked alias: kept linked',
    'not-a-color': 'Not a literal color: kept as it is',
  } as const;
</script>

<ul class="roles" aria-label={`${mode} mode proposals`} data-testid={`palette-roles-${mode}`}>
  {#each ordered as role (role.key)}
    <li class="role" data-skipped={role.skipped ?? undefined} data-testid="palette-role">
      <div class="role__title">
        <strong>{role.name}</strong>
        <code>{role.path}</code>
        {#if role.anchor}<span class="tag">Anchor</span>{/if}
      </div>
      <dl class="role__values">
        <div>
          <dt>Original ({role.originalSpace})</dt>
          <dd>
            <span
              class="swatch"
              style:background={role.skipped === 'not-a-color' ? 'transparent' : role.originalText}
            ></span>
            <code>{role.originalText}</code>
          </dd>
        </div>
        <div>
          <dt>Proposed (OKLCH)</dt>
          <dd>
            <span class="swatch" style:background={role.proposedText}></span>
            <code data-testid="palette-proposed">{role.proposedText}</code>
          </dd>
        </div>
      </dl>
      <p class="role__notes">
        {#if role.skipped !== null}{SKIPPED[role.skipped]}.{/if}
        {#if role.reducedFromChroma !== null && role.skipped === null}
          Chroma reduced from {Math.round(role.reducedFromChroma * 1000) / 1000} to fit the gamut.
        {/if}
      </p>
      <div class="role__controls">
        {#if role.skipped !== 'alias' && role.skipped !== 'not-a-color'}
          <Checkbox
            id={`palette-lock-${role.key}`}
            label={`Lock ${role.path} in ${mode} mode`}
            checked={locked.has(role.key)}
            onValueChange={(on) => onLock(role.key, on)}
          />
        {/if}
        {#if role.override !== null && role.skipped === null}
          <Checkbox
            id={`palette-include-${role.key}`}
            label={`Replace the existing override of ${role.path} (${role.override.text})`}
            checked={included.has(role.key)}
            onValueChange={(on) => onInclude(role.key, on)}
          />
        {/if}
      </div>
    </li>
  {/each}
</ul>

<style>
  .roles {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .role {
    display: grid;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    min-width: 0;
  }
  .role[data-skipped] {
    background: var(--cinder-surface-inset);
  }
  .role__title {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
  }
  .tag {
    padding: 0 6px;
    border: 1px solid var(--cinder-border-strong);
    border-radius: var(--cinder-radius-md);
    font-size: var(--cinder-text-xs);
  }
  .role__values {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 8px;
    margin: 0;
  }
  dt {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
  }
  dd {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .swatch {
    flex: none;
    width: 1.25rem;
    height: 1.25rem;
    border: 1px solid var(--cinder-border-strong);
    border-radius: var(--cinder-radius-sm, 4px);
  }
  code {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }
  .role__notes {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
  }
  .role__notes:empty {
    display: none;
  }
  .role__controls {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
</style>
