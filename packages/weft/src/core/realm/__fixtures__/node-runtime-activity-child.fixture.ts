import {
  NODE_RUNTIME_WORKFLOW_NAME,
  nodeRuntimeActivityHandler,
} from './node-runtime-activity-handler.fixture.ts';
import { initializeRevisionRealmChildProcess } from './revision-realm-child-process-generator-entry.ts';

initializeRevisionRealmChildProcess({ [NODE_RUNTIME_WORKFLOW_NAME]: nodeRuntimeActivityHandler });
