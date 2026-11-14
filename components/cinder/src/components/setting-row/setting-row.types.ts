import type { Snippet } from 'svelte';
import type { FormFieldManaged } from '../form-field/form-field.types.ts';

/**
 * Where a setting's own save has got to, drawn as a status line under its description.
 *
 * - `saving`: the request is in flight after the field was left ("Saving…", with a spinning glyph).
 * - `saved`: the value was just saved and is in effect ("Saved just now", in the success tone).
 * - `restart`: the static property of a setting that only applies after a restart, before it is
 *   changed ("Applies after restart", with a restart glyph).
 * - `saved-restart`: saved but not yet in effect ("Saved, waiting for a restart", with an amber dot).
 * - `reverted`: a saved change that waited for a restart was put back to the value in effect
 *   ("Reverted, in effect now", muted, with no glyph).
 */
export type SettingRowStatus = 'saving' | 'saved' | 'restart' | 'saved-restart' | 'reverted';

export type SettingRowProps = {
  /**
   * Stable id forwarded into `FormField` context, which associates the
   * generated `<label for={id}>` with it. Only a control that opts into
   * and reads that context receives `id` automatically—for a native
   * element or a third-party component that doesn't, the label is
   * unassociated unless the host also applies `id` to that control
   * directly, the same qualification as `required` and `disabled`.
   */
  id: string;
  /** Visible setting label. */
  label: string;
  /**
   * The raw key behind the label, drawn small and monospaced beside it ("engine.maxConcurrentRuns").
   * It sits outside the `<label>`, so it never becomes part of the control's accessible name.
   */
  identifier?: string;
  /**
   * Where the setting's own save has got to: `saving`, `saved`, `restart`, `saved-restart` or
   * `reverted`. It draws a status line under the description, in a polite live region that is
   * always mounted, so a change from Saving to Saved is announced. Leave it unset for a setting at
   * rest. Pair it with `error` for the failures: an invalid value or a save that did not go through.
   */
  status?: SettingRowStatus;
  /** Replaces the words of the status line, such as "Saved 2 minutes ago" for `saved`. The glyph and tone still follow `status`. */
  statusLabel?: string;
  /**
   * Called by the quiet Retry beside the error, for a save that did not go through ("Couldn't
   * save. Your value is still in the field. Retry"), and beside `loadError`, for a read that did
   * not. Leave it unset for an invalid value, where retrying changes nothing and the person fixes
   * the field instead.
   */
  onRetry?: () => void;
  /**
   * Label of the retry action drawn beside the error or the load error when `onRetry` is set.
   * @default "Retry"
   */
  retryLabel?: string;
  /**
   * Says that what the row's control offers did not load ("Couldn't load the models. Retry"), such
   * as the options of a select. It is an advisory, in the warning tone and not the error's, so the
   * control is not marked invalid, and it takes the place of `warning` while it is set. With
   * `onRetry` it ends in the same quiet Retry the error has. While `error` is also set, the Retry
   * stays beside the error, which `onRetry` is for.
   */
  loadError?: string;
  /** Guidance text describing the setting. */
  description?: string;
  /** Rendered after the description inside the same paragraph, so it joins `aria-describedby`: a quiet link such as "Open Health". Shown only with `description`. */
  descriptionAction?: Snippet;
  /**
   * Advisory message. `FormField` renders this text itself, as a sibling
   * of the control, not through context—a custom `control` that reads
   * `FormField` context sees only the derived `warningId` (and the
   * composed `describedBy`) to associate with, never the message string
   * itself.
   */
  warning?: string;
  /**
   * Corrective error message. `FormField` renders this text itself, as a
   * sibling of the control, not through context—a custom `control` that
   * reads `FormField` context sees only the derived `errorId`, `invalid`,
   * and the composed `describedBy`, never the message string itself.
   */
  error?: string;
  /**
   * Renders the required marker and forwards `required` into `FormField`
   * context. Only takes effect for a control that opts into and reads that
   * context—it never adds a native `required` attribute, so a control that
   * doesn't consume the context still passes browser constraint validation
   * and must receive `required` directly. `SettingRow` forwards `undefined`
   * when omitted; `FormField` normalizes that to `false`. Defaults to
   * `false`.
   * @default false
   */
  required?: boolean;
  /**
   * Forwards a disabled state into `FormField` context for the row's
   * control. Only takes effect for a control that opts into and reads that
   * context—a native element or a third-party component that doesn't
   * consume it stays interactive and must receive `disabled` directly.
   * Does not disable automatically while saving. `SettingRow` forwards
   * `undefined` when omitted; `FormField` normalizes that to `false`.
   * Defaults to `false`.
   * @default false
   */
  disabled?: boolean;
  /**
   * Renders a managed-policy line with a lock glyph; pair with `PolicyLock`. Give it a `message`
   * for a locked setting ("Locked by your deployment (remote mode). Change it in the deployment's
   * configuration."). The control stays the page's to make read-only.
   */
  managed?: FormFieldManaged;
  /**
   * The width of the column the control sits in, as a CSS length (`"25rem"`). Leave it unset for the
   * default of `15rem`, which fits a switch, a short field or a select; give a control that needs
   * more room, such as the address of a feed or a list of switches, its own. Below the container
   * width where the row stacks, the control takes the row's width whatever this says.
   */
  controlWidth?: string;
  /** The setting's control, rendered with `FormField` context applied. */
  control: Snippet;
  /** Optional disclosure content rendered beneath the row. */
  disclosure?: Snippet;
  /** Additional class merged with the component's root class. */
  class?: string;
};
