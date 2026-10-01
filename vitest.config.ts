// 單元測試只跑 test/unit/ 底下的檔案；e2e 用 `npm run test:e2e`（node test/e2e/run.mjs）另外跑
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
