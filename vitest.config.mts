import * as path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    // The Comments API adapter imports `vscode`, which only exists in the
    // Extension Host. Alias it to an in-memory mock so the adapter is testable.
    alias: { vscode: path.resolve(__dirname, 'test/vscode-mock.ts') },
  },
});
