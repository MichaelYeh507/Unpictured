import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Shader tests run in headless Chromium. SwiftShader (software WebGL) gives the same GPU on
// every machine, including CI runners that have no GPU at all.
export default defineConfig({
  test: {
    include: ["src/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});
