import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// web/ has only browser tests (*.browser.test.ts); plain logic belongs in core/ and its tests.
// They run in headless Chromium. SwiftShader (software WebGL) gives the same GPU on every
// machine, including CI runners that have no GPU at all.
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
