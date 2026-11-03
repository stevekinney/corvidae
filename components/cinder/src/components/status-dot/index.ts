import './status-dot.css';
import StatusDot from './status-dot.svelte';

export default StatusDot;
export type {
  StatusDotConnectionState,
  StatusDotProps,
  StatusDotSize,
  StatusDotStatus,
  StatusDotWordTone,
} from './status-dot.types.ts';
export {
  statusDotWordTones,
  statusForStatusDotWord,
  type StatusDotWord,
  type StatusDotWordLabel,
} from './status-dot.words.ts';
export { StatusDot };
