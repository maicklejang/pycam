/* Run the docscan web tests in a headless browser.
 *
 *   python3 docscan/web/tests/make-fixtures.py   # once, needs the python package
 *   node docscan/web/tests/run.mjs
 *
 * The runner serves the repository over http, executes the module tests from
 * tests.js and then drives the real app with a fake camera that plays the
 * rendered document clip.  It exits non-zero when anything fails.
 */

import { createServer } from "node:http";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const ROOT = resolve(WEB, "..", "..");
const PORT = Number(process.env.DOCSCAN_TEST_PORT || 8917);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function serve() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      let path = resolve(ROOT, "." + normalize(url.pathname));
      if (!path.startsWith(ROOT)) { response.writeHead(403).end(); return; }
      if ((await stat(path)).isDirectory()) path = join(path, "index.html");
      const body = await readFile(path);
      response.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
      response.end(body);
    } catch (error) {
      response.writeHead(404).end("not found");
    }
  });
  return new Promise((ready) => server.listen(PORT, "127.0.0.1", () => ready(server)));
}

async function loadPlaywright() {
  try {
    return (await import("playwright")).chromium;
  } catch (error) {
    console.error("playwright is not installed.  Run:  npm install playwright");
    process.exit(2);
    return null;
  }
}

function launchOptions(fixtures) {
  const options = {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  };
  const clip = join(fixtures, "fakecam.y4m");
  if (existsSync(clip)) options.args.push(`--use-file-for-fake-video-capture=${clip}`);
  // honour a preinstalled browser, as used by CI images
  if (process.env.DOCSCAN_CHROMIUM) options.executablePath = process.env.DOCSCAN_CHROMIUM;
  return options;
}

async function main() {
  const fixtures = join(HERE, "fixtures");
  if (!existsSync(join(fixtures, "fixtures.json"))) {
    console.error("fixtures are missing - run:  python3 docscan/web/tests/make-fixtures.py");
    process.exit(2);
  }
  if (!existsSync(join(WEB, "vendor", "opencv.js"))) {
    console.error("opencv.js is missing - run:  docscan/web/fetch-opencv.sh");
    process.exit(2);
  }

  const chromium = await loadPlaywright();
  const server = await serve();
  const profile = await mkdtemp(join(tmpdir(), "docscan-test-"));
  const browser = await chromium.launch(launchOptions(fixtures));
  let failures = 0;
  try {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 }, permissions: ["camera"], acceptDownloads: true,
    });
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push("pageerror: " + error.message));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push("console: " + message.text());
    });

    /* -- module tests ---------------------------------------------------- */
    await page.goto(`http://127.0.0.1:${PORT}/docscan/web/tests/harness.html`);
    const results = await page.evaluate(() => window.docscanTests, { timeout: 120000 });
    for (const result of results) {
      console.log(`${result.ok ? "  ok  " : "  FAIL"}  ${result.name}`
                  + (result.note ? `  — ${result.note}` : ""));
      if (!result.ok) failures += 1;
    }

    /* -- the app, driven through its UI ---------------------------------- */
    await page.goto(`http://127.0.0.1:${PORT}/docscan/web/`);
    const steps = [];
    const step = async (name, body) => {
      try {
        const note = await body();
        steps.push({ name, ok: true, note });
      } catch (error) {
        steps.push({ name, ok: false, note: error.message });
      }
    };

    await step("the app starts and opens the camera", async () => {
      await page.waitForFunction(() => document.getElementById("splash").hidden,
                                 null, { timeout: 60000 });
      await page.waitForFunction(() => !document.getElementById("video").paused,
                                 null, { timeout: 20000 });
      return "camera running";
    });
    await step("the live preview detects the page", async () => {
      await page.waitForFunction(
        () => document.getElementById("status").textContent.includes("감지"),
        null, { timeout: 30000 });
      const painted = await page.evaluate(() => {
        const canvas = document.getElementById("overlay");
        const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
        let count = 0;
        for (let index = 3; index < data.length; index += 4) if (data[index] > 0) count += 1;
        return count;
      });
      if (painted < 1000) throw new Error("the outline was not drawn (" + painted + " px)");
      return `${painted} overlay pixels`;
    });
    await step("the shutter stores a page", async () => {
      await page.click("#shutter");
      await page.waitForFunction(
        () => document.getElementById("page-count").textContent === "1",
        null, { timeout: 30000 });
      return await page.textContent("#toast");
    });
    await step("a second page can use another colour mode", async () => {
      const chips = await page.$$("#modes .chip");
      await chips[3].click();
      await page.click("#shutter");
      await page.waitForFunction(
        () => document.getElementById("page-count").textContent === "2",
        null, { timeout: 30000 });
      return "2 pages";
    });
    await step("the gallery lists both pages", async () => {
      await page.click("#gallery");
      await page.waitForSelector(".thumb img");
      const labels = await page.$$eval(".thumb .thumb__index",
                                       (nodes) => nodes.map((node) => node.textContent));
      if (labels.length !== 2) throw new Error("thumbnails: " + labels.length);
      return labels.join(", ");
    });
    await step("a page can be rotated", async () => {
      const before = await page.$eval(".thumb img", (node) => node.naturalWidth);
      await page.click(".thumb .thumb__tools button");
      await page.waitForTimeout(600);
      const after = await page.$eval(".thumb img", (node) => node.naturalWidth);
      if (before === after) throw new Error("the thumbnail did not change shape");
      return `${before} -> ${after} px wide`;
    });
    await step("the pages export as a PDF", async () => {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 60000 }),
        page.click("#sheet-pdf"),
      ]);
      const target = join(profile, "export.pdf");
      await download.saveAs(target);
      const bytes = await readFile(target);
      const text = bytes.toString("latin1");
      if (!text.startsWith("%PDF")) throw new Error("not a PDF");
      if (!/\/Count 2\b/.test(text)) throw new Error("wrong page count");
      return `${download.suggestedFilename()}, ${bytes.length} bytes`;
    });
    await step("pages come back after a reload", async () => {
      await page.click("#sheet-close");
      await page.reload();
      await page.waitForFunction(
        () => document.getElementById("page-count").textContent === "2",
        null, { timeout: 60000 });
      return "restored from IndexedDB";
    });
    await step("the service worker caches the app for offline use", async () => {
      const state = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        const names = await caches.keys();
        const cache = names.length ? await caches.open(names[0]) : null;
        const keys = cache ? await cache.keys() : [];
        return {
          registered: Boolean(registration),
          entries: keys.length,
          opencv: keys.some((request) => request.url.endsWith("opencv.js")),
        };
      });
      if (!state.registered) throw new Error("no service worker");
      if (!state.opencv) throw new Error("opencv.js was not cached");
      return `${state.entries} cached files`;
    });

    for (const result of steps) {
      console.log(`${result.ok ? "  ok  " : "  FAIL"}  ${result.name}`
                  + (result.note ? `  — ${result.note}` : ""));
      if (!result.ok) failures += 1;
    }
    if (problems.length) {
      failures += problems.length;
      problems.forEach((problem) => console.log("  FAIL  " + problem));
    }
    console.log(`\n${failures ? failures + " failure(s)" : "all tests passed"}`);
  } finally {
    await browser.close();
    server.close();
    await rm(profile, { recursive: true, force: true });
  }
  process.exit(failures ? 1 : 0);
}

main();
