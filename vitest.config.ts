import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { defineConfig } from 'vitest/config';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-test-'));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { BOOKFLIX_DATA: data },
    fileParallelism: false,
    setupFiles: ['tests/setup-guard.ts'],
    testTimeout: 30000,
  },
});
