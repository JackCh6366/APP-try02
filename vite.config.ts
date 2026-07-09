import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  
  // 忽略 api 資料夾，Vercel Serverless Function 不需要被 Vite build
  build: {
    rollupOptions: {
      external: ['api/generate.ts', 'api/generate']
    }
  }
})