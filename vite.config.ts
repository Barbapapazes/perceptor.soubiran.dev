import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [cloudflare()],
  // cf deploy uploads generated server maps; never place these in public assets.
  build: { sourcemap: true },
});
