import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/beinan-planpad/",
  plugins: [react()],
  worker: { format: "es" },
  build: { chunkSizeWarningLimit: 4000 },
});
