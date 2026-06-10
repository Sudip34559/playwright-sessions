import { defineConfig } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";

const envVars = Object.fromEntries(
  readFileSync(path.join(__dirname, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => l.split("=").map((s) => s.trim()) as [string, string]),
);

const USERNAMES = (envVars.USERNAMES || "admin").split(",").filter(Boolean);

console.log(USERNAMES);

export default defineConfig({
  testDir: ".",
  timeout: 1200000, // 20 min per test
  workers: USERNAMES.length, // one worker per username = one browser per user
  fullyParallel: true,
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
        "--use-fake-device-for-media-stream",
        "--auto-select-desktop-capture-source=Entire screen",
        "--enable-features=WindowPlacement",
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
