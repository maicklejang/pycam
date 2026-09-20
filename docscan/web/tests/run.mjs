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
    const canvasBox = () => page.evaluate(() => {
      const box = document.getElementById("editor-canvas").getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    });
    const sizeFromToast = async () => {
      const toast = await page.textContent("#toast");
      const match = /(\d+)\D+(\d+)\)/.exec(toast);
      if (!match) throw new Error("no page size in the toast: " + toast);
      return { width: Number(match[1]), height: Number(match[2]), toast };
    };
    const openShutter = async () => {
      await page.click("#shutter");
      await page.waitForSelector("#editor:not([hidden])", { timeout: 30000 });
    };
    const applyEditor = async (expected) => {
      await page.click("#editor-apply");
      await page.waitForFunction(
        (count) => document.getElementById("page-count").textContent === String(count),
        expected, { timeout: 30000 });
      await page.waitForSelector("#editor", { state: "hidden" });
    };

    await step("the shot keeps every pixel the camera gives", async () => {
      const camera = await page.evaluate(() => {
        const video = document.getElementById("video");
        return [video.videoWidth, video.videoHeight];
      });
      await page.click("#shutter");
      await page.waitForSelector("#editor", { state: "visible", timeout: 60000 });
      const shown = await page.$eval("#editor-size", (node) => node.textContent);
      const [width, height] = shown.split("×").map(Number);
      // a still may be larger than the preview (ImageCapture) but never
      // smaller: cropping a page out of a preview frame is what makes small
      // print unreadable
      if (!(width >= camera[0] && height >= camera[1])) {
        throw new Error(`shot ${shown} against a ${camera.join("×")} camera`);
      }
      await page.click("#editor-cancel");
      await page.waitForSelector("#editor", { state: "hidden", timeout: 60000 });
      return `${shown} from a ${camera.join("×")} preview`;
    });

    await step("the shutter opens the region editor with the page outlined", async () => {
      await openShutter();
      const outline = await page.evaluate(() => {
        const canvas = document.getElementById("editor-canvas");
        const { data } = canvas.getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height);
        let green = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index + 1] > 150 && data[index] < 120 && data[index + 2] < 140) {
            green += 1;
          }
        }
        return green;
      });
      if (outline < 500) throw new Error("no outline drawn (" + outline + " px)");
      return `${outline} outline pixels`;
    });

    let draggedArea = 0;
    await step("dragging a corner changes the region", async () => {
      await page.click("#editor-all");      // corners sit on the photo corners now
      const box = await canvasBox();
      await page.mouse.move(box.left + 3, box.top + 3);
      await page.mouse.down();
      await page.mouse.move(box.left + box.width * 0.3, box.top + box.height * 0.3,
                            { steps: 8 });
      await page.mouse.up();
      await applyEditor(1);
      const size = await sizeFromToast();
      draggedArea = size.width * size.height;
      return `${size.width}x${size.height}`;
    });

    await step("the same shot without the drag gives a different page", async () => {
      await openShutter();
      await page.click("#editor-all");
      await applyEditor(2);
      const size = await sizeFromToast();
      const area = size.width * size.height;
      // not "smaller": cutting a corner off steepens the perspective, and the
      // recovered rectangle can come out larger.  What matters is that the
      // drag reached the pipeline at all.
      if (Math.abs(area - draggedArea) < draggedArea * 0.1) {
        throw new Error(`the drag changed nothing: ${area} vs ${draggedArea}`);
      }
      return `${size.width}x${size.height} against ${draggedArea} px^2 dragged`;
    });

    await step("bending an edge flattens the page", async () => {
      await openShutter();
      await page.click("#editor-all");
      const box = await canvasBox();
      // the top edge handle sits in the middle of the top border; pull it down
      await page.mouse.move(box.left + box.width / 2, box.top + 3);
      await page.mouse.down();
      await page.mouse.move(box.left + box.width / 2, box.top + box.height * 0.12,
                            { steps: 8 });
      await page.mouse.up();
      await applyEditor(3);
      const { toast } = await sizeFromToast();
      if (!toast.includes("평탄화")) throw new Error("not flattened: " + toast);
      return toast;
    });

    await step("cancelling the editor keeps the page count", async () => {
      await openShutter();
      await page.click("#editor-cancel");
      await page.waitForSelector("#editor", { state: "hidden" });
      const count = await page.textContent("#page-count");
      if (count !== "3") throw new Error("page count became " + count);
      return "still 3 pages";
    });

    await step("a page can use another colour mode", async () => {
      const chips = await page.$$("#modes .chip");
      await chips[3].click();
      await openShutter();
      await applyEditor(4);
      return "4 pages";
    });

    await step("the region check can be switched off", async () => {
      await page.click("#manual");
      await page.click("#shutter");
      await page.waitForFunction(
        () => document.getElementById("page-count").textContent === "5",
        null, { timeout: 30000 });
      if (await page.$("#editor:not([hidden])")) {
        throw new Error("the editor opened although it was switched off");
      }
      await page.click("#manual");
      return "captured without the editor";
    });

    await step("the gallery lists every page", async () => {
      await page.click("#gallery");
      await page.waitForSelector(".thumb img");
      const labels = await page.$$eval(".thumb .thumb__index",
                                       (nodes) => nodes.map((node) => node.textContent));
      if (labels.length !== 5) throw new Error("thumbnails: " + labels.length);
      return labels.join(", ");
    });
    await step("a thumbnail opens the page full screen", async () => {
      await page.click(".thumb img");
      await page.waitForSelector("#viewer[open]");
      const shown = await page.$eval("#viewer-position", (node) => node.textContent);
      if (shown !== "1 / 5") throw new Error("position reads " + shown);
      const sizes = await page.evaluate(() => {
        const image = document.getElementById("viewer-image");
        const thumb = document.querySelector(".thumb img");
        return { big: image.getBoundingClientRect().width,
                 small: thumb.getBoundingClientRect().width };
      });
      if (!(sizes.big > sizes.small * 2)) {
        throw new Error(`the page is only ${Math.round(sizes.big)} px wide`);
      }
      return `${shown}, ${Math.round(sizes.big)} px wide`;
    });
    await step("the viewer walks through the pages and zooms", async () => {
      await page.click("#viewer-next");
      await page.waitForFunction(
        () => document.getElementById("viewer-position").textContent === "2 / 5");
      const box = await page.$eval("#viewer-stage", (node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      await page.mouse.click(box.x, box.y);
      await page.mouse.click(box.x, box.y, { delay: 20 });
      await page.waitForTimeout(150);
      const zoom = await page.$eval("#viewer-image", (node) => node.style.transform);
      if (!/scale\((?!1\))/.test(zoom)) throw new Error("no zoom: " + zoom);
      await page.keyboard.press("0");
      await page.click("#viewer-close");
      await page.waitForSelector("#viewer[open]", { state: "detached" });
      return "page 2, then " + zoom.replace(/\s+/g, " ");
    });
    await step("pages can be put in another order", async () => {
      // the fourth page is the black and white one, so walking it to the
      // front is visible in the badges
      const read = () => page.$$eval(".thumb .thumb__index",
                                     (nodes) => nodes.map((node) => node.textContent));
      const before = await read();
      if (!before[3].includes("흑백")) throw new Error("expected 4 to be 흑백: " + before);
      for (let slot = 4; slot > 1; slot -= 1) {
        // eslint-disable-next-line no-await-in-loop
        await page.click(`.thumb:nth-child(${slot}) .thumb__order button:first-child`);
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(200);
      }
      const after = await read();
      if (after.length !== before.length) throw new Error("a page went missing");
      if (!after[0].includes("흑백")) throw new Error("order now " + after.join());
      const disabled = await page.$eval(".thumb .thumb__order button:first-child",
                                        (node) => node.disabled);
      if (!disabled) throw new Error("the first page can still move forwards");
      return before.join(", ") + "  ->  " + after.join(", ");
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
      if (!/\/Count 5\b/.test(text)) throw new Error("wrong page count");
      return `${download.suggestedFilename()}, ${bytes.length} bytes`;
    });
    await step("pages come back after a reload, in the order they were put in",
               async () => {
                 const before = await page.$$eval(".thumb .thumb__index",
                                                  (nodes) => nodes.map((n) => n.textContent));
                 await page.click("#sheet-close");
                 await page.reload();
                 await page.waitForFunction(
                   () => document.getElementById("page-count").textContent === "5",
                   null, { timeout: 60000 });
                 await page.click("#gallery");
                 await page.waitForSelector(".thumb img");
                 const after = await page.$$eval(".thumb .thumb__index",
                                                 (nodes) => nodes.map((n) => n.textContent));
                 if (after.join() !== before.join()) {
                   throw new Error(`order changed: ${before.join()} -> ${after.join()}`);
                 }
                 await page.click("#sheet-close");
                 return "restored from IndexedDB: " + after.join(", ");
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
