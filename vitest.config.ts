import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    reporters: ["verbose"],
    exclude: [".claude/**", "node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: [
        "dist/**",
        "scripts/**",
        "prompts/**",
        "**/*.test.ts",
        "**/*.config.ts",
        "coverage/**",
      ],
    },
  },
});
