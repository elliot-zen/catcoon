import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
  optimizeDeps: { entries: ["index.html"] },
  plugins: [react(), tailwind()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4310",
        // Preserve the browser-facing host so the API can verify same-origin writes.
        changeOrigin: false,
      },
    },
  },
});
