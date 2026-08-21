import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // 插件仓库作为主仓库 submodule 挂载于 plugins/，SDK 位于主仓库根 plugin-sdk/
      '@workavatar/plugin-sdk': path.resolve(__dirname, '../plugin-sdk/src'),
      '@workavatar/plugin-sdk/renderer': path.resolve(__dirname, '../plugin-sdk/src/renderer'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    globals: true,
  },
})
