import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
const dependencyRoots = ['node_modules', '../node_modules', 'node_modules/@nalu/ai-runtime', '../node_modules/@nalu/ai-runtime'].map(name => path.resolve(__dirname, name)).filter(existsSync).map(name => realpathSync(name))

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['@nalu/ai-runtime'], include: ['@mlc-ai/web-llm', '@wllama/wllama/esm/index.js'] },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    fs: { allow: [path.resolve(__dirname, '..'), ...dependencyRoots] },
    port: 5180,
    strictPort: true,
  },
})
