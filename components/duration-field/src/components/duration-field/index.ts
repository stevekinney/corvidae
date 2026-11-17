import './duration-field.css';
import DurationField from './duration-field.svelte';

export default DurationField;
export type { DurationFieldProps } from './duration-field.types.ts';
export {
  DURATION_UNITS,
  durationUnitFor,
  fromMilliseconds,
  toMilliseconds,
} from './duration-units.ts';
export type { DurationUnit } from './duration-units.ts';
export { DurationField };
