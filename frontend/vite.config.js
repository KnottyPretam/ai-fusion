import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Ports come from the environment so parallel agents / Playwright never collide.
const backendPort = process.env.BACKEND_PORT || process.env.PORT || '8001'
const vitePort = Number(process.env.VITE_PORT || 5173)

export default defineConfig({
  plugins: [react()],
  server: {
    port: vitePort,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
})
