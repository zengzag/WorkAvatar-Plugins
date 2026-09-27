import { defineConfig } from 'vitest/config'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 插件自带依赖（如 workflow 的 @xyflow/react）安装在各自插件目录下，为单测补齐解析路径 */
function pluginDepAlias(pkg: string): string | undefined {
  const dirs = fs.readdirSync(__dirname, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'node_modules' && d.name !== 'tests')
  for (const d of dirs) {
    const candidate = path.join(__dirname, d.name, 'node_modules', pkg)
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

export default defineConfig({
  resolve: {
    alias: {
      // 插件仓库作为主仓库 submodule 挂载于 plugins/，SDK 位于主仓库根 plugin-sdk/
      '@workavatar/plugin-sdk': path.resolve(__dirname, '../plugin-sdk/src'),
      '@workavatar/plugin-sdk/renderer': path.resolve(__dirname, '../plugin-sdk/src/renderer'),
      '@xyflow/react': pluginDepAlias('@xyflow/react'),
    },
  },
  test: {
    root: __dirname,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    globals: true,
    server: {
      deps: {
        // 单测直接引用插件源码（.ts/.tsx），交给 vite 转换而非 Node 原生解析
        inline: [/plugins[\\/].*[\\/]src[\\/]/],
        fallbackCJS: true,
      },
    },
  },
})
