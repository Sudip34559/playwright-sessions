import { test, expect } from "@playwright/test";
import path from "path";
import dotenv from "dotenv";
import pidusage from "pidusage";
import os from "os";
import { execSync } from "child_process";
import { readdirSync, readFileSync } from "fs";

// ─── Load .env from same directory as this file ───────────────────────────────
dotenv.config({ path: path.join(__dirname, ".env") });

// ─── All configuration from environment ──────────────────────────────────────
const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const TEMPLATE_ID = process.env.TEMPLATE_ID || "incidents-disabled";
const PASSWORD = process.env.PASSWORD || "admin123";
const STAGGER_TIME_MS = Number(process.env.STAGGER_TIME_MS) || 8000;
const WAITING_TIME_MS = Number(process.env.WAITING_TIME_MS) || 600000;

const RUN_PHOTO_CAPTURE = process.env.RUN_PHOTO_CAPTURE === "true";
const RUN_ID_VERIFICATION = process.env.RUN_ID_VERIFICATION === "true";
const RUN_MOBILE_RECORDING = process.env.RUN_MOBILE_RECORDING === "true";
const RUN_ROOM_SCAN = process.env.RUN_ROOM_SCAN === "true";

const USERNAMES_STRING = process.env.USERNAMES || "admin";
const usernames = USERNAMES_STRING.split(",")
  .map((n) => n.trim())
  .filter((n) => n.length > 0);

// ─── Asset paths ──────────────────────────────────────────────────────────────
const VIDEO_FILE_PATH = path.join(__dirname, "assets", "face-test.mp4");
const VIDEO_ROUTE_URL = "**/test-assets/face-test.mp4";
const VIDEO_FETCH_URL = `${BASE_URL}/test-assets/face-test.mp4`;

// ─── PID Detection ────────────────────────────────────────────────────────────
function getBrowserPidAfterLaunch(launchTimestamp: number): number | null {
  try {
    if (os.platform() === "darwin") {
      const out = execSync(
        'ps -eo pid,lstart,comm | grep -E "chromium|chrome-headless|Chromium" | grep -v grep',
        { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
      ).trim();
      if (!out) return null;

      const candidates = out
        .split("\n")
        .flatMap((line) => {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[0]);
          const dateStr = parts.slice(1, 6).join(" ");
          const startTime = new Date(dateStr).getTime();
          return isNaN(pid) || isNaN(startTime) ? [] : [{ pid, startTime }];
        })
        .filter((l) => l.startTime >= launchTimestamp - 3000);

      if (!candidates.length) return null;
      candidates.sort((a, b) => a.startTime - b.startTime);
      return candidates[0].pid;
    } else {
      const procDirs = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
      const uptime = parseFloat(
        readFileSync("/proc/uptime", "utf8").split(" ")[0],
      );
      const bootTime = Date.now() - uptime * 1000;

      const candidates: Array<{ pid: number; startTime: number }> = [];
      for (const dir of procDirs) {
        try {
          const cmdline = readFileSync(`/proc/${dir}/cmdline`, "utf8");
          if (
            !cmdline.includes("chromium") &&
            !cmdline.includes("chrome") &&
            !cmdline.includes("headless_shell")
          )
            continue;
          const stat = readFileSync(`/proc/${dir}/stat`, "utf8");
          const startJiff = parseInt(stat.split(" ")[21]);
          const startTime = bootTime + (startJiff / 100) * 1000;
          candidates.push({ pid: parseInt(dir), startTime });
        } catch {
          /* process may have exited */
        }
      }
      if (!candidates.length) return null;
      candidates.sort(
        (a, b) =>
          Math.abs(a.startTime - launchTimestamp) -
          Math.abs(b.startTime - launchTimestamp),
      );
      return candidates[0].pid;
    }
  } catch {
    return null;
  }
}

// ─── Process Tree ─────────────────────────────────────────────────────────────
function getAllDescendantPids(rootPid: number): number[] {
  const pids = new Set<number>([rootPid]);
  const getChildren = (pid: number): number[] => {
    try {
      if (os.platform() === "darwin") {
        const out = execSync(`pgrep -P ${pid}`, {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "ignore"],
        }).trim();
        return out ? out.split("\n").map(Number).filter(Boolean) : [];
      } else {
        const out = readFileSync(
          `/proc/${pid}/task/${pid}/children`,
          "utf8",
        ).trim();
        return out ? out.split(/\s+/).map(Number).filter(Boolean) : [];
      }
    } catch {
      return [];
    }
  };
  const queue = [rootPid];
  while (queue.length) {
    const p = queue.shift()!;
    getChildren(p).forEach((c) => {
      if (!pids.has(c)) {
        pids.add(c);
        queue.push(c);
      }
    });
  }
  return [...pids];
}

// ─── Sampling ─────────────────────────────────────────────────────────────────
async function sampleProcessTree(
  pids: number[],
): Promise<{ cpu: number; ram: number }> {
  let cpu = 0,
    ram = 0;
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const s = await pidusage(pid);
        cpu += s.cpu;
        ram += s.memory;
      } catch {}
    }),
  );
  return { cpu, ram };
}

// ─── Summary ──────────────────────────────────────────────────────────────────
interface Sample {
  ts: number;
  cpu: number;
  ramMB: number;
}

function printAndBuildSummary(
  workerIndex: number,
  username: string,
  samples: Sample[],
) {
  if (!samples.length) {
    console.log(
      `Worker ${workerIndex} (${username}): ⚠️  No metric samples — PID was not detected.`,
    );
    return null;
  }

  const cpus = samples.map((s) => s.cpu);
  const rams = samples.map((s) => s.ramMB);
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const dur = (samples[samples.length - 1].ts - samples[0].ts) / 1000;

  const peakCPU = Math.max(...cpus),
    avgCPU = avg(cpus);
  const peakRAM = Math.max(...rams),
    avgRAM = avg(rams);

  const safetyFactor = 1.3;
  const vcpu = (avgCPU / 100) * safetyFactor;
  const ramG = (peakRAM / 1024) * safetyFactor;

  const W = 58;
  const pad = (s: string) => s.padEnd(W);
  console.log(`\n╔${"═".repeat(W)}╗`);
  console.log(
    `║ ${pad(`📊 RESOURCE USAGE — Worker ${workerIndex} (${username})`)}║`,
  );
  console.log(`╠${"═".repeat(W)}╣`);
  console.log(
    `║ ${pad(`  Samples : ${samples.length}   Duration : ${dur.toFixed(0)}s   Interval : 2s`)}║`,
  );
  console.log(`╠${"═".repeat(W)}╣`);
  console.log(
    `║ ${pad(`  CPU  peak: ${peakCPU.toFixed(2).padStart(7)}%    avg: ${avgCPU.toFixed(2).padStart(7)}%`)}║`,
  );
  console.log(
    `║ ${pad(`  RAM  peak: ${peakRAM.toFixed(0).padStart(7)} MB   avg: ${avgRAM.toFixed(0).padStart(7)} MB`)}║`,
  );
  console.log(`╠${"═".repeat(W)}╣`);
  console.log(
    `║ ${pad(`  EC2 sizing  (avg CPU + peak RAM + 30% headroom):`)}║`,
  );
  console.log(`║ ${pad(`    vCPU per session  →  ${vcpu.toFixed(3)}`)}║`);
  console.log(`║ ${pad(`    RAM  per session  →  ${ramG.toFixed(2)} GB`)}║`);
  console.log(
    `║ ${pad(`    × 100 sessions    →  ${Math.ceil(vcpu * 100)} vCPUs  /  ${Math.ceil(ramG * 100)} GB RAM`)}║`,
  );
  console.log(`╚${"═".repeat(W)}╝\n`);

  return {
    workerIndex,
    username,
    samples,
    peakCPU,
    avgCPU,
    peakRAM,
    avgRAM,
    durationSec: dur,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────
for (const username of usernames) {
  test(`Full Proctoring Flow: Stability Optimized [User: ${username}]`, async ({
    page,
  }, testInfo) => {
    console.log("------------------------------------------------");
    console.log(`🛠️  Template ID     : "${TEMPLATE_ID}"`);
    console.log(`🛠️  User            : "${username}"`);
    console.log(`🛠️  Photo Capture   : ${RUN_PHOTO_CAPTURE}`);
    console.log(`🛠️  ID Verification : ${RUN_ID_VERIFICATION}`);
    console.log(`🛠️  Mobile Recording: ${RUN_MOBILE_RECORDING}`);
    console.log(`🛠️  Room Scan       : ${RUN_ROOM_SCAN}`);
    console.log(`🛠️  Stagger Time    : ${STAGGER_TIME_MS}ms per worker`);
    console.log("------------------------------------------------");

    const staggerTime = testInfo.workerIndex * STAGGER_TIME_MS;
    test.setTimeout(1200000 + staggerTime);

    console.log(
      `Worker ${testInfo.workerIndex} (${username}): Delaying start by ${staggerTime / 1000}s...`,
    );
    await page.waitForTimeout(staggerTime);

    // ── PID detection ──────────────────────────────────────────────────────
    const testStartTime = Date.now() - staggerTime - 5000;
    const browserPid = getBrowserPidAfterLaunch(testStartTime);

    let samplerInterval: ReturnType<typeof setInterval> | null = null;
    const metricSamples: Sample[] = [];

    if (browserPid) {
      const allPids = getAllDescendantPids(browserPid);
      console.log(
        `Worker ${testInfo.workerIndex} (${username}): 📡 Tracking ${allPids.length} process(es) [root PID: ${browserPid}]`,
      );

      samplerInterval = setInterval(async () => {
        try {
          const { cpu, ram } = await sampleProcessTree(allPids);
          metricSamples.push({ ts: Date.now(), cpu, ramMB: ram / 1024 / 1024 });
        } catch {}
      }, 2000);
    } else {
      console.log(
        `Worker ${testInfo.workerIndex} (${username}): ⚠️  Could not detect browser PID.`,
      );
    }

    // ── Video interception ────────────────────────────────────────────────
    await page.route(VIDEO_ROUTE_URL, async (route) => {
      await route.fulfill({
        path: VIDEO_FILE_PATH,
        contentType: "video/mp4",
        headers: {
          "Cache-Control": "public, max-age=31536000",
          "Accept-Ranges": "bytes",
        },
      });
    });

    await page.addInitScript(
      ({ videoUrl, id }: { videoUrl: string; id: number }) => {
        let _cameraStreamPromise: Promise<MediaStream> | null = null;

        function getCameraStream(): Promise<MediaStream> {
          if (_cameraStreamPromise) return _cameraStreamPromise;
          _cameraStreamPromise = new Promise((resolve, reject) => {
            const video = document.createElement("video");
            video.src = videoUrl;
            video.loop = true;
            video.muted = true;
            video.playsInline = true;
            video.crossOrigin = "anonymous";
            video.preload = "auto";

            video.oncanplay = async () => {
              try {
                await video.play();
                const canvas = document.createElement("canvas");
                canvas.width = 320;
                canvas.height = 240;
                const ctx = canvas.getContext("2d")!;
                setInterval(() => {
                  ctx.drawImage(video, 0, 0, 320, 240);
                  ctx.fillStyle = `hsla(${(id * 47) % 360}, 75%, 35%, 0.75)`;
                  ctx.fillRect(0, 0, 96, 24);
                  ctx.fillStyle = "white";
                  ctx.font = "bold 13px monospace";
                  ctx.fillText(`P-${id}`, 8, 17);
                }, 1000 / 30);
                resolve(canvas.captureStream(30));
              } catch (err) {
                reject(err);
              }
            };
            video.onerror = () =>
              reject(new Error(`Could not load test video: ${videoUrl}`));
            video.load();
          });
          return _cameraStreamPromise;
        }

        const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices,
        );
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          if (constraints?.video) {
            const stream = await getCameraStream();
            if (constraints.audio) {
              try {
                const audioStream = await _origGetUserMedia({
                  audio: constraints.audio,
                  video: false,
                });
                audioStream.getAudioTracks().forEach((t) => stream.addTrack(t));
              } catch (_) {}
            }
            return stream;
          }
          return _origGetUserMedia(constraints);
        };

        (window as any).getScreenDetails = async () => ({
          screens: [
            { label: "Primary Monitor", isPrimary: true, isInternal: true },
          ],
        });

        if (navigator.mediaDevices) {
          navigator.mediaDevices.getDisplayMedia = async () => {
            const stream = await getCameraStream();
            const [origTrack] = stream.getVideoTracks();
            const clonedTrack = origTrack.clone();
            const origGetSettings = clonedTrack.getSettings.bind(clonedTrack);
            clonedTrack.getSettings = () => ({
              ...origGetSettings(),
              displaySurface: "monitor",
              logicalSurface: true,
            });
            return new MediaStream([clonedTrack]);
          };
        }
      },
      { videoUrl: VIDEO_FETCH_URL, id: testInfo.workerIndex + 1 },
    );

    // ── Navigation ────────────────────────────────────────────────────────
    await page.route("**/templates", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      });
    });

    console.log(
      `Worker ${testInfo.workerIndex} (${username}): 🌐 Navigating to exam page...`,
    );
    let gotoSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(`${BASE_URL}/exam?templateId=${TEMPLATE_ID}`);
        gotoSuccess = true;
        break;
      } catch (err) {
        console.log(
          `Worker ${testInfo.workerIndex} (${username}): ⚠️ goto failed (attempt ${attempt}/3), retrying in 5s...`,
        );
        await page.waitForTimeout(5000);
      }
    }
    if (!gotoSuccess)
      throw new Error(`Failed to load page for ${username} after 3 attempts`);

    await expect(page).toHaveURL(/.*login/, { timeout: 15000 });
    console.log(
      `Worker ${testInfo.workerIndex} (${username}): 🔒 Redirected to login.`,
    );

    // ── Login ─────────────────────────────────────────────────────────────
    await page.getByPlaceholder("Username").fill(username);
    await page.getByPlaceholder("Password").fill(PASSWORD);
    await page.getByRole("button", { name: /login|sign in/i }).click();
    await expect(page).toHaveURL(new RegExp(`.*exam.*`), { timeout: 30000 });
    console.log(`Worker ${testInfo.workerIndex} (${username}): ✅ Logged in.`);

    const screenShareBtn = page.getByRole("button", { name: /share screen/i });
    if (await screenShareBtn.isVisible()) await screenShareBtn.click();

    // ── AI model wait ─────────────────────────────────────────────────────
    if (RUN_PHOTO_CAPTURE || RUN_ID_VERIFICATION) {
      console.log(
        `Worker ${testInfo.workerIndex} (${username}): ⏳ Waiting for AI models...`,
      );
      const captureBtn = page.getByRole("button", { name: /capture/i });
      await expect(captureBtn).toBeEnabled({ timeout: 300000 });
      console.log(
        `Worker ${testInfo.workerIndex} (${username}): ✅ AI models ready.`,
      );
    } else {
      console.log(
        `Worker ${testInfo.workerIndex} (${username}): ⏭️ Skipping AI wait.`,
      );
    }

    const filePath = path.join(__dirname, "assets", "face.png");

    // ── Step 1: Photo capture ─────────────────────────────────────────────
    if (RUN_PHOTO_CAPTURE) {
      console.log(`📤 Step 1 (${username}): Uploading photo...`);
      await page.locator('input[type="file"]').first().setInputFiles(filePath);
      const nextBtn1 = page
        .getByLabel("Identity verification")
        .getByRole("button", { name: "Next" });
      await nextBtn1.waitFor({ state: "visible", timeout: 60000 });
      await nextBtn1.dispatchEvent("click");
    } else {
      console.log(`⏭️ Step 1 (${username}): Photo Capture skipped`);
    }

    // ── Step 1.1: ID verification ─────────────────────────────────────────
    if (RUN_ID_VERIFICATION) {
      console.log(`📤 Step 1.1 (${username}): Uploading ID photo...`);
      await page.waitForTimeout(5000);
      const inputCount = await page.locator('input[type="file"]').count();
      const fileInput = page.locator('input[type="file"]').nth(inputCount - 1);
      await fileInput.setInputFiles(filePath);
      try {
        await fileInput.evaluate((e) =>
          e.dispatchEvent(new Event("change", { bubbles: true })),
        );
        await fileInput.evaluate((e) =>
          e.dispatchEvent(new Event("input", { bubbles: true })),
        );
      } catch (err) {
        console.log(`⚠️ Manual event failed for ${username}:`, err);
      }
      await page.waitForTimeout(5000);
      const nextBtn2 = page
        .getByLabel("Identity verification")
        .getByRole("button", { name: "Next" });
      await nextBtn2.waitFor({ state: "visible", timeout: 60000 });
      await nextBtn2.dispatchEvent("click");
    } else {
      console.log(`⏭️ Step 1.1 (${username}): ID Verification skipped`);
    }

    // ── Step 3: Environment / room scan ───────────────────────────────────
    if (RUN_MOBILE_RECORDING || RUN_ROOM_SCAN) {
      console.log(`➡️ Step 3 (${username}): Verify Environment...`);

      const qrUrlPromise = new Promise<string>((resolve) => {
        const handler = (msg) => {
          const text = msg.text();
          if (text.includes("QR Code URL:")) {
            const m = text.match(/(http[s]?:\/\/[^\s]+)/);
            if (m) {
              page.removeListener("console", handler);
              resolve(m[1]);
            }
          }
        };
        page.on("console", handler);
      });

      const envTitle = page
        .locator(".p-dialog-title")
        .filter({ hasText: /Record your environment/i });
      await expect(envTitle).toBeVisible({ timeout: 300000 });

      let mobileUrl = await qrUrlPromise;
      if (mobileUrl.includes("http://") && !mobileUrl.includes("localhost")) {
        const parsedUrl = new URL(mobileUrl);
        parsedUrl.hostname = "localhost";
        mobileUrl = parsedUrl.toString();
      }

      console.log(`📱 Step 3 (${username}): Opening mobile tab: ${mobileUrl}`);
      const mobilePage = await page.context().newPage();
      await mobilePage.goto(mobileUrl);

      if (RUN_ROOM_SCAN) {
        console.log(`📱 Step 3.2 (${username}): Starting room scan...`);
        const startRecordBtn = mobilePage.getByRole("button", {
          name: /start recording room/i,
        });
        await expect(startRecordBtn).toBeVisible({ timeout: 30000 });
        await startRecordBtn.click();

        console.log(
          `⏳ Step 3.2 (${username}): Recording room for 1 minute...`,
        );
        const uploadBtn = mobilePage.getByRole("button", { name: /^Upload$/i });
        await uploadBtn.waitFor({ state: "visible", timeout: 75000 });
        await mobilePage.waitForTimeout(5000);
        await uploadBtn.click();
        await mobilePage.waitForTimeout(5000);
      } else if (RUN_MOBILE_RECORDING) {
        console.log(`📱 Step 3.1 (${username}): Mobile recording hold mode...`);
      }

      const nextBtn4 = page
        .getByRole("button", { name: "Next" })
        .filter({ visible: true })
        .last();
      await expect(nextBtn4).toBeEnabled({ timeout: 60000 });
      await nextBtn4.click();
    } else {
      console.log(`⏭️ Step 3 (${username}): Environment/Mobile Scan skipped`);
    }

    // ── Step 4: Equipment check ───────────────────────────────────────────
    console.log(`➡️ Step 4 (${username}): Equipment Check...`);
    const equipTitle = page
      .locator(".p-dialog-title")
      .filter({ hasText: /Equipment check/i });
    await expect(equipTitle).toBeVisible({ timeout: 300000 });

    await page.waitForTimeout(8000);

    const nextBtn5 = page
      .getByRole("button", { name: "Next" })
      .filter({ visible: true })
      .last();
    const deadline = Date.now() + 120000;

    while (await nextBtn5.isDisabled()) {
      if (Date.now() > deadline)
        throw new Error(`Equipment checks never passed for ${username}`);
      const retryBtn = page.getByRole("button", { name: /retry/i }).first();
      if (await retryBtn.isVisible()) {
        console.log(
          `Worker ${testInfo.workerIndex} (${username}): 🔄 Retrying failed check...`,
        );
        await retryBtn.click();
        await page.waitForTimeout(6000);
      } else {
        await page.waitForTimeout(2000);
      }
    }

    console.log(
      `Worker ${testInfo.workerIndex} (${username}): ✅ All checks passed.`,
    );
    await nextBtn5.click({ force: true });

    // ── Live snapshot at exam start ───────────────────────────────────────
    if (metricSamples.length > 0) {
      const s = metricSamples[metricSamples.length - 1];
      console.log(
        `Worker ${testInfo.workerIndex} (${username}): 📊 Exam start — CPU: ${s.cpu.toFixed(2)}%  RAM: ${s.ramMB.toFixed(0)} MB`,
      );
    }

    // ── Wait for session duration ─────────────────────────────────────────
    console.log(
      `🛑 ${username}: Holding session for ${WAITING_TIME_MS / 60000} minute(s)...`,
    );
    await page.waitForTimeout(WAITING_TIME_MS);

    // ── Live snapshot at exam end ─────────────────────────────────────────
    if (metricSamples.length > 0) {
      const s = metricSamples[metricSamples.length - 1];
      console.log(
        `Worker ${testInfo.workerIndex} (${username}): 📊 Exam end — CPU: ${s.cpu.toFixed(2)}%  RAM: ${s.ramMB.toFixed(0)} MB`,
      );
    }

    // ── Finish session ────────────────────────────────────────────────────
    console.log(
      `Worker ${testInfo.workerIndex} (${username}): 🏁 Clicking Finish Session...`,
    );
    const finishBtn = page.getByRole("button", { name: /Finish Session/i });
    if (await finishBtn.isVisible()) {
      await finishBtn.click();
      await page.waitForTimeout(2000);
    }

    // ── Stop sampler + summary ────────────────────────────────────────────
    if (samplerInterval) clearInterval(samplerInterval);

    const summary = printAndBuildSummary(
      testInfo.workerIndex,
      username,
      metricSamples,
    );
    if (summary) {
      await testInfo.attach("resource-usage.json", {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(summary, null, 2)),
      });
    }

    console.log(`🎉 Test finished for ${username}.`);
  });
}
