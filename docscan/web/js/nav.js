/* The back gesture, made to mean "one step back" instead of "quit".
 *
 * Installed to the home screen, the app is the whole screen: the system back
 * button is the only way out of anything, and by default it leaves the app
 * altogether - even with the gallery or the region editor open on top.  That
 * loses the pages a person was looking at, for what they meant as "close
 * this".
 *
 * So every screen that opens over another one registers here.  Opening pushes
 * a history entry and back closes the topmost screen.  With nothing left
 * open, the first back press only warns, so the app is never left by a stray
 * tap.
 *
 * What is open is tracked here, not read back out of the history: a screen
 * that closes itself asks the browser to go back, and that request arrives as
 * a popstate a moment later - possibly after the next screen has already
 * opened.  Counting those echoes and otherwise trusting the stack keeps the
 * two in step whatever the order turns out to be.
 */

const EXIT_GRACE = 2500;        // ms in which a second back press really exits

const layers = [];
let echoes = 0;                 // back requests we made ourselves
let fromPop = false;
let warnedAt = 0;
let warn = null;

/** Note that `name` is now on screen; `dismiss` closes it. */
export function openLayer(name, dismiss) {
  layers.push({ name, dismiss });
  history.pushState({ docscan: name, depth: layers.length }, "");
}

/** Note that `name` closed itself (a button, Escape, a finished edit). */
export function closeLayer(name) {
  const index = layers.map((layer) => layer.name).lastIndexOf(name);
  if (index < 0) return;
  layers.splice(index, 1);
  if (fromPop) return;          // the back press itself did the closing
  echoes += 1;
  history.back();
}

function onPopState() {
  if (echoes > 0) {
    echoes -= 1;                // our own back request coming home
    return;
  }
  const top = layers.pop();
  if (top) {
    fromPop = true;
    try {
      top.dismiss();
    } finally {
      fromPop = false;
    }
    return;
  }
  // nothing left to close: this press would leave the app
  const now = Date.now();
  if (now - warnedAt < EXIT_GRACE) return;    // asked twice: let it go
  warnedAt = now;
  history.pushState({ docscan: "root" }, "");
  if (warn) warn();
}

/**
 * Start guarding the back button.  `onExitAttempt` is called when back would
 * leave the app, so the app can say that pressing it again does exactly that.
 */
export function guardBack(onExitAttempt) {
  warn = onExitAttempt;
  history.pushState({ docscan: "root" }, "");
  window.addEventListener("popstate", onPopState);
}
