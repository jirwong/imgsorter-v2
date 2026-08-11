import { RecordsPhase } from './records-phase';
import { ResyncPhase } from './resync-phase';
import { ScanPhase } from './scan-phase';
import type { Phase } from './types';

// Phases are stateless singletons — all deps arrive via the PhaseContext.
export const PHASES: readonly Phase[] = [new ScanPhase(), new ResyncPhase(), new RecordsPhase()];
