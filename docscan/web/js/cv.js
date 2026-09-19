/* Loading of OpenCV.js.
 *
 * The WebAssembly build is ~13 MB, so it is not kept in the repository: it is
 * either fetched into web/vendor/ (see fetch-opencv.sh, which the deploy
 * workflow runs) or, when that copy is missing, pulled from a CDN.  Both are
 * the same release, and the service worker caches whichever one is used, so
 * the app only downloads it once.
 */

// resolved against this module, so the loader also works from sub pages
const VENDOR_URL = new URL("../vendor/opencv.js", import.meta.url).href;
const CDN_URL = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js";

let loading = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve(url);
    script.onerror = () => {
      script.remove();
      reject(new Error("failed to load " + url));
    };
    document.head.appendChild(script);
  });
}

/** Resolve once OpenCV is ready to use; resolves to the `cv` namespace. */
export function loadOpenCV(onProgress = () => {}) {
  if (loading) return loading;
  loading = (async () => {
    onProgress("이미지 엔진 준비 중…");
    try {
      await loadScript(VENDOR_URL);
    } catch (error) {
      onProgress("이미지 엔진 내려받는 중…");
      await loadScript(CDN_URL);
    }
    // The UMD build assigns window.cv; recent Emscripten builds hand back a
    // promise for the initialised module, older ones the module itself.
    const candidate = window.cv;
    if (!candidate) throw new Error("OpenCV.js did not register itself");
    const cv = typeof candidate.then === "function" ? await candidate : candidate;
    if (!cv.Mat) {
      // very old builds signal readiness through a callback instead
      await new Promise((resolve) => { cv.onRuntimeInitialized = resolve; });
    }
    window.cv = cv;
    return cv;
  })();
  return loading;
}

/** Run `body` and delete every Mat registered with the `keep` callback. */
export function withMats(body) {
  const owned = [];
  const keep = (mat) => { owned.push(mat); return mat; };
  try {
    return body(keep);
  } finally {
    for (const mat of owned) {
      try { if (mat && !mat.isDeleted()) mat.delete(); } catch (error) { /* already gone */ }
    }
  }
}
