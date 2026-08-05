import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 相对 glob，不带 packages/ 或 apps/ 前缀——这样同一份配置在两种 cwd 下都成立：
    // 仓库根跑（vitest 把 root 当作仓库根，匹配全部包）与单包跑（turbo run test
    // 在包目录下执行，root 变成包目录，匹配该包自己的用例）。
    // 写死 packages/*/... 的话，单包执行时一个文件都匹配不到，pnpm test 直接失败。
    include: ['**/src/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
