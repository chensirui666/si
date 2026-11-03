import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const target = `http://127.0.0.1:${process.env.AGENT_LEARNING_SERVER_PORT ?? '3000'}`
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': { target, changeOrigin: false, rewrite: path => path.replace(/^\/auth(?=\?|$)/, '/') },
      '/api': { target, ws: true, changeOrigin: false, rewriteWsOrigin: false },
    },
  },
})
