import type { Snippet } from 'svelte';
import type { FormFieldManaged } from '../form-field/form-field.types.ts';
export type SettingRowProps = {
  /** Stable id shared with the composed control. */
  id: string;
  /** Visible setting label. */
  label: string;
  /** Guidance text describing the setting. */
  description?: string;
  /** Advisory message forwarded through `FormField` context. */
  warning?: string;
  /** Corrective error message forwarded through `FormField` context. */
  error?: string;
  /** Marks the setting as required. */
  required?: boolean;
  /** Disables the row's control. Does not disable automatically while saving. */
  disabled?: boolean;
  /** Renders a managed-policy indicator; pair with `PolicyLock`. */
  managed?: FormFieldManaged;
  /** The setting's control, rendered with `FormField` context applied. */
  control: Snippet;
  /** Optional disclosure content rendered beneath the row. */
  disclosure?: Snippet;
  /** Additional class merged with the component's root class. */
  class?: string;
};
