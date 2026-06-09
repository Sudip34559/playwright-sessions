import { defineConfig } from "@playwright/test";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, ".env") });

const USERNAMES = (process.env.USERNAMES || "admin").split(",").filter(Boolean);

export default defineConfig({
  testDir: ".",
  timeout: 1200000, // 20 min per test
  workers: USERNAMES.length, // one worker per username = one browser per user

  use: {
    headless: true,
    viewport: { width: 1920, height: 1080 },
    permissions: ["camera", "microphone"],
    launchOptions: {
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--use-fake-ui-for-media-stream",
        "--use-fake-video-for-tests",
        "--disable-gpu",
      ],
    },
  },

  reporter: [
    ["list"], // live output in terminal
    ["html", { open: "never" }], // full HTML report after run
  ],
});
