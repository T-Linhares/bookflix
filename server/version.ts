import { PLACEHOLDER_REPO } from '../shared/bugReport.ts';

/** Kept equal to package.json by a test (tests/version-check.test.ts). */
export const APP_VERSION = '0.3.1';

/**
 * "owner/repo" on GitHub: where releases are announced and bug reports go. Replace the value before the first public
 * release; while it still equals PLACEHOLDER_REPO the bug button and the update notice stay switched off.
 */
export const DEFAULT_REPO = 'T-Linhares/bookflix';

/** BOOKFLIX_REPO overrides it (tests, forks). */
export const getRepo = () => process.env.BOOKFLIX_REPO || DEFAULT_REPO || PLACEHOLDER_REPO;
