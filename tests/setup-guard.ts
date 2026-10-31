import { beforeEach } from 'vitest';
import { guardConfig, resetGuard } from '../server/metadata/guard.ts';

// Every test starts with Google open, no cache and no waiting; google-guard.test.ts sets its own clock and spacing.
guardConfig.minGapMs = 0;
guardConfig.retryDefaultWaitMs = 0;
beforeEach(() => resetGuard());
