/**
 * COR-1898 — `memory.embedder`, the embedder governed memory embeds with, and the switch a change to
 * it starts.
 *
 * The setting is what the owner asked for; governed memory's switch record is what is happening.
 * A write naming another embedder than the active one starts a switch, which re-embeds every stored
 * memory into a new profile and makes it active once it holds them all. Every maintenance pass
 * advances the switch. A switch that fails or is cancelled sets the setting back to the embedder
 * memory still uses, so the setting never names an embedder memory is not switching to.
 *
 * @module memory-embedder-setting
 */

import { DEFAULT_SWITCH_STEP_LIMIT, type GovernedMemory } from '@lostgradient/memory';

import type { SettingsFailure } from './settings/settings-validation.ts';
import type { SettingKey, SettingsValues } from './settings/settings-schema.ts';
import type { BureauSettings } from './settings/types.ts';

/** How many times a pass tries to set the setting back when another write keeps moving its revision. */
const RESET_ATTEMPTS = 3;

/** What {@link createMemoryEmbedderSetting} reads and writes. */
export interface MemoryEmbedderSettingDependencies {
  /** The Bureau's governed memory; without it every write of the setting is refused. */
  readonly memory: GovernedMemory | undefined;
  /** The settings in force now. */
  readonly settings: () => SettingsValues;
  /** `bureau.settings`, through which a failed or cancelled switch sets the key back. */
  readonly bureauSettings: () => BureauSettings | undefined;
  /** Reports what a pass could not do. */
  readonly diagnose: (message: string, cause?: unknown) => void;
}

/** The reader of `memory.embedder`. */
export interface MemoryEmbedderSetting {
  /**
   * Why a patch's `memory.embedder` would be refused: no governed memory, an embedder that is not
   * loaded or needs setup, or a switch already running. The embedder memory already uses is always
   * accepted when no switch runs, so a failed switch can set the key back even while that
   * embedder is not loaded.
   */
  failures(values: SettingsValues): Promise<SettingsFailure[]>;
  /** Starts the switch an applied write asks for. */
  afterUpdate(keys: readonly SettingKey[]): Promise<void>;
  /**
   * One maintenance pass: advances the running switch (a step also finishes a profile deletion
   * that stopped part-way), starts one a write asked for that never started, and sets the setting
   * back after a switch that failed or was cancelled.
   */
  reconcile(): Promise<void>;
}

/** Builds the reader of `memory.embedder`. */
export function createMemoryEmbedderSetting(
  dependencies: MemoryEmbedderSettingDependencies,
): MemoryEmbedderSetting {
  const { memory, settings } = dependencies;
  let reconciling: Promise<void> | undefined;

  /** Sets `memory.embedder` to `embedder`, unless another write already changed it. */
  async function setBack(requested: string, embedder: string): Promise<void> {
    const bureauSettings = dependencies.bureauSettings();
    if (bureauSettings === undefined) return;
    for (let attempt = 1; attempt <= RESET_ATTEMPTS; attempt++) {
      const snapshot = await bureauSettings.get();
      if (snapshot.values['memory.embedder'] !== requested) return;
      const result = await bureauSettings.update(
        { 'memory.embedder': embedder },
        { expectedRevision: snapshot.revision },
      );
      if (result.outcome === 'applied') return;
      if (result.reason !== 'stale-revision') {
        dependencies.diagnose(
          `[bureau] Setting memory.embedder back to "${embedder}" was refused: ${result.message}`,
        );
        return;
      }
    }
    dependencies.diagnose(
      `[bureau] memory.embedder still names "${requested}" after a switch that did not complete; the next maintenance pass sets it back.`,
    );
  }

  /**
   * Starts a switch to `requested`. Returns whether memory refused it outright: the embedder is not
   * loaded or needs setup, which a write checked but which may have changed since.
   */
  async function start(target: GovernedMemory, requested: string): Promise<boolean> {
    const result = await target.embedding.switchTo(requested);
    if (result.outcome === 'started') return false;
    if (result.reason !== 'not-loaded' && result.reason !== 'needs-setup') return false;
    dependencies.diagnose(`[bureau] The memory embedder switch did not start: ${result.message}`);
    return true;
  }

  async function reconcileOnce(target: GovernedMemory): Promise<void> {
    // Every pass, a switch running or not: a step also finishes a profile deletion a stopped
    // process left part-way. Memory's own step size: a larger store takes several passes.
    const status = await target.embedding.advance({ limit: DEFAULT_SWITCH_STEP_LIMIT });
    const requested = settings()['memory.embedder'];
    const active = status.active.embedder;
    if (requested === undefined || requested === active || status.job?.state === 'running') return;
    if (status.job !== undefined && status.job.target === requested) {
      // The switch the setting asked for failed or was cancelled.
      await setBack(requested, active);
      return;
    }
    // A write whose switch never started: this process stopped between the two.
    if (await start(target, requested)) await setBack(requested, active);
  }

  return {
    async failures(values) {
      const requested = values['memory.embedder'];
      if (requested === undefined) return [];
      const refuse = (message: string): SettingsFailure[] => [
        { keys: ['memory.embedder'], message },
      ];
      if (memory === undefined) return refuse('This Bureau has no governed memory to embed');
      const status = await memory.embedding.status();
      if (status.job?.state === 'running') {
        return refuse(
          `A switch to the embedder "${status.job.target}" is running (${status.job.done} of ${status.job.total} memories); cancel it or wait for it to finish`,
        );
      }
      if (requested === status.active.embedder) return [];
      const availability = memory.embedding.availability(requested);
      if (availability === 'not-loaded') {
        return refuse(`No embedder is loaded as "${requested}" (not-loaded)`);
      }
      if (availability === 'needs-setup') {
        return refuse(
          `The embedder "${requested}" needs setup before memory can use it (needs-setup)`,
        );
      }
      return [];
    },

    async afterUpdate(keys) {
      if (memory === undefined || !keys.includes('memory.embedder')) return;
      const requested = settings()['memory.embedder'];
      if (requested === undefined) return;
      const status = await memory.embedding.status();
      if (requested === status.active.embedder || status.job?.state === 'running') return;
      // Runs inside the settings update, which `setBack` would wait on, so a refusal is set back
      // by the next maintenance pass instead.
      await start(memory, requested);
    },

    reconcile() {
      if (memory === undefined) return Promise.resolve();
      reconciling ??= reconcileOnce(memory)
        .catch((error: unknown) => {
          dependencies.diagnose('[bureau] The memory embedder pass failed.', error);
        })
        .finally(() => {
          reconciling = undefined;
        });
      return reconciling;
    },
  };
}
