import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [cloudflareTest({ config: "./cloudflare.config.ts", remoteBindings: false })],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
