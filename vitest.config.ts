import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@slate/shared": r("./packages/shared/src/index.ts"),
      "@slate/db": r("./packages/db/src/index.ts"),
      "@": r("./apps/web"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/web/test/**/*.test.ts"],
    environment: "node",
  },
});
