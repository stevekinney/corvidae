/**
 * The three positions of a ThemeSwitch: always light, always dark, or follow the system setting.
 * The switch only reports the position; the application decides what each one means.
 */
export type ThemeSwitchValue = 'light' | 'system' | 'dark';

/**
 * Props for the ThemeSwitch component.
 *
 * ThemeSwitch is a three-position Light, System, Dark control in the Toggle family. It is a
 * radiogroup of three icon buttons over one quiet sky or night track, so exactly one position is
 * always selected. It reports the position through `value` and `onValueChange` and does not touch
 * the document; applying the theme is the caller's job.
 */
export type ThemeSwitchProps = {
  /** Native id placed on the radiogroup element. */
  id?: string;
  /**
   * The selected position. Bindable.
   * @default "system"
   */
  value?: ThemeSwitchValue;
  /** Notify after the user selects a position, with the position that was selected. */
  onValueChange?: (next: ThemeSwitchValue) => void;
  /**
   * Accessible name of the radiogroup. The three positions are named Light, System and Dark.
   * @default "Theme"
   */
  label?: string;
  /** Prevents interaction when true. Sets `disabled` on each position. */
  disabled?: boolean;
  /** Additional class names merged with `.cinder-theme-switch` on the radiogroup. */
  class?: string;
};
