/* Keeping captured pages across reloads.
 *
 * Phones suspend and reload tabs freely, and losing a stack of scanned pages
 * to a background reload is the kind of thing that makes an app useless.  The
 * pages therefore live in IndexedDB as blobs; every call degrades gracefully
 * when storage is unavailable (private mode, blocked storage).
 */

const DATABASE = "docscan";
const STORE = "pages";

function open() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("no IndexedDB")); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(mode, body) {
  return open().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    const request = body(store);
    transaction.oncomplete = () => { database.close(); resolve(request && request.result); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  }));
}

/** Pages in the order the user put them in, oldest first by default. */
export async function loadPages() {
  const rows = await transact("readonly", (store) => store.getAll());
  return (rows || []).sort((a, b) => {
    const mine = typeof a.order === "number" ? a.order : (a.created || 0);
    const yours = typeof b.order === "number" ? b.order : (b.created || 0);
    return mine - yours;
  });
}

/**
 * Store one page.  `created` is stamped once, when the page first arrives:
 * re-saving a page (a rotation, say) must not move it to the end of the
 * stack, and neither must it lose the place the user dragged it to.
 */
export function savePage(page) {
  const created = page.created || Date.now();
  return transact("readwrite", (store) => store.put({
    ...page,
    created,
    order: typeof page.order === "number" ? page.order : created,
  }));
}

/** Store several pages in one transaction - used when the order changes. */
export function savePages(pages) {
  return transact("readwrite", (store) => {
    pages.forEach((page, index) => {
      store.put({ ...page, created: page.created || Date.now(), order: index });
    });
    return null;
  });
}

export function removePage(id) {
  return transact("readwrite", (store) => store.delete(id));
}

export function clearPages() {
  return transact("readwrite", (store) => store.clear());
}
