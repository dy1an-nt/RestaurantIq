import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
//
// No dev proxy: the frontend talks to the backend via the absolute
// `VITE_API_URL` (see src/lib/api.ts), so local development exercises the same
// cross-origin path as production instead of hiding it behind a proxy.
export default defineConfig({
  plugins: [react()],
})
