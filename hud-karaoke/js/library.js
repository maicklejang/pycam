/*
 * Song library.
 *
 * Everything lives in IndexedDB on the device: a car is exactly the place
 * where the network disappears, so audio blobs and lyrics are kept locally and
 * nothing is ever uploaded anywhere.
 */

const DB_NAME = "hud-karaoke";
const DB_VERSION = 1;
const STORE = "songs";

let connection = null;

function openDatabase() {
    if (connection) {
        return connection;
    }
    connection = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: "id" });
                store.createIndex("createdAt", "createdAt");
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return connection;
}

async function withStore(mode, run) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request ? request.result : undefined);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

export function newId() {
    return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function listSongs() {
    const songs = (await withStore("readonly", (store) => store.getAll())) || [];
    songs.sort((a, b) => b.createdAt - a.createdAt);
    return songs;
}

export async function getSong(id) {
    return withStore("readonly", (store) => store.get(id));
}

export async function saveSong(song) {
    const record = { createdAt: Date.now(), ...song };
    if (!record.id) {
        record.id = newId();
    }
    await withStore("readwrite", (store) => store.put(record));
    return record;
}

export async function deleteSong(id) {
    await withStore("readwrite", (store) => store.delete(id));
}

/** Rough size of the library, shown in the settings panel. */
export async function storageUsage() {
    if (!navigator.storage || !navigator.storage.estimate) {
        return null;
    }
    try {
        const { usage: used, quota } = await navigator.storage.estimate();
        return { used: used || 0, quota: quota || 0 };
    } catch (error) {
        return null;
    }
}

/**
 * Ask the browser to keep the library around instead of evicting it when the
 * device runs low on space.  Silently ignored where unsupported.
 */
export async function requestPersistence() {
    if (!navigator.storage || !navigator.storage.persist) {
        return false;
    }
    try {
        if (await navigator.storage.persisted()) {
            return true;
        }
        return await navigator.storage.persist();
    } catch (error) {
        return false;
    }
}
