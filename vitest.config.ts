import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@slate/shared/port-detect": r("./packages/shared/src/port-detect.ts"),
      "@slate/shared": r("./packages/shared/src/index.ts"),
      "@slate/db": r("./packages/db/src/index.ts"),
      "@slate/bridge": r("./packages/bridge/src/index.ts"),
      "@slate/agent-tools/goals": r("./packages/agent-tools/src/goals.ts"),
      "@slate/agent-tools": r("./packages/agent-tools/src/index.ts"),
      "@": r("./apps/web"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/web/test/**/*.test.ts"],
    environment: "node",
  },
});
