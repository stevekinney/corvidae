import type { DetectorContext } from 'armorer';

import type { RecordGovernance } from '../../src/governance/record-governance';

// Armorer types the record's source, class and trust as plain strings (it cannot import Memory's
// types); what Memory fills them from must stay assignable to them.
declare const governance: RecordGovernance;

const told: NonNullable<DetectorContext['memory']> = {
  source: governance.source,
  memoryClass: governance.memoryClass,
  trust: governance.trust,
};

void told;
