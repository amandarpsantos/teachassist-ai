/**
 * TeachAssist AI — Recording Chunk Store
 *
 * Durable, incremental persistence for MediaRecorder chunks, so that
 * losing the offscreen document, the MediaRecorder, the meeting tab,
 * or the service worker can never make an in-progress or just-
 * finished recording unrecoverable. Chunks are written to IndexedDB
 * as they arrive (piggybacking on the existing ~1-second
 * ondataavailable cadence) — this is the primary durable recording
 * asset, not merely an emergency backup: both a normal stop and a
 * recovery-after-failure reconstruct lesson.webm from what's stored
 * here.
 *
 * Loaded from two separate JS contexts that cannot share a
 * module-level database handle — the offscreen document (where
 * chunks are produced) and the background service worker (where
 * recovery/finalization/deletion happen). Each opens its own
 * IndexedDB connection to the same origin-scoped "TeachAssistDB"
 * database; the schema below is written defensively
 * (objectStoreNames.contains guards) so it is safe regardless of
 * which context's connection happens to perform the actual
 * version-upgrade first. services/lesson-db.js independently defines
 * the same two stores for the same reason — see the comment there.
 *
 * This file deliberately contains no transcription, AI, or dashboard
 * logic — only chunk storage, retrieval, gap detection, and the
 * per-session recovery-state bookkeeping needed for idempotency.
 */

const RecordingChunkStore = (() => {
  const DATABASE_NAME = "TeachAssistDB";
  // MUST always equal services/lesson-db.js's own DATABASE_VERSION —
  // both files open the same underlying IndexedDB database by the
  // same name, and IndexedDB refuses to open a database at a version
  // lower than its current stored version (a hard VersionError, not a
  // warning). lesson-db.js is loaded first everywhere (offscreen.html,
  // background.js's importScripts) and already brings the database to
  // its own DATABASE_VERSION at service-worker startup — so any
  // mismatch here fails every single recording start, not just
  // sometimes. If lesson-db.js's version is ever bumped, this must be
  // bumped to match in the same change.
  //
  // Deliberately 4, not 3: an earlier build shipped this file at
  // DATABASE_VERSION 2 while lesson-db.js was already at 3, which
  // meant every open() here failed outright (CHUNK_STORE_INIT_FAILED)
  // and this file's onupgradeneeded — where recordingChunks/
  // recordingChunkSessions actually get created — never ran. Anyone
  // who already hit that has a real "TeachAssistDB" sitting at
  // version 3 with those two stores still missing. Simply matching
  // "3" now would open successfully but skip onupgradeneeded entirely
  // (IndexedDB only runs it when opening at a version HIGHER than the
  // database's current version), leaving those stores permanently
  // absent for exactly the people who already ran into this. Version
  // 4 guarantees a real upgrade transaction runs for every installed
  // copy — fresh or already-broken — creating whatever's missing.
  const DATABASE_VERSION = 4;

  const CHUNKS_STORE = "recordingChunks";
  const SESSIONS_STORE = "recordingChunkSessions";

  // Session-level lifecycle, tracked durably so recovery is
  // idempotent even across a service worker restart. "recording" is
  // the only state chunks are actively written under; every other
  // state means finalization/recovery has already been attempted or
  // completed for this session.
  const SESSION_STATUS = Object.freeze({
    RECORDING: "recording",
    RECOVERY_IN_PROGRESS: "recovery_in_progress",
    RECOVERED: "recovered",
    RECOVERY_FAILED: "recovery_failed",
    RECONSTRUCTED: "reconstructed", // normal-stop path completed successfully
    DELETED: "deleted"
  });

  let databasePromise = null;

  function openDatabase() {
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          const chunksStore = db.createObjectStore(CHUNKS_STORE, {
            keyPath: "id",
            autoIncrement: true
          });

          chunksStore.createIndex("sessionId", "sessionId", {
            unique: false
          });

          chunksStore.createIndex(
            "sessionIdAndSequence",
            ["sessionId", "sequenceNumber"],
            { unique: true }
          );
        }

        if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
          db.createObjectStore(SESSIONS_STORE, {
            keyPath: "sessionId"
          });
        }
      };

      request.onsuccess = (event) => resolve(event.target.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        console.warn(
          "TeachAssist RecordingChunkStore: database upgrade is blocked by another open connection."
        );
      };
    });

    return databasePromise;
  }

  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Creates the durable session record. Called once, at recording
   * start, before the MediaRecorder itself begins — a failure here
   * is treated as a hard failure of starting the recording at all
   * (by the caller in offscreen.js), since silently falling back to
   * memory-only recording would defeat the entire purpose of this
   * store.
   */
  async function initSession({ sessionId, lessonId, mimeType }) {
    const db = await openDatabase();
    const tx = db.transaction([SESSIONS_STORE], "readwrite");
    const now = new Date().toISOString();

    await promisifyRequest(
      tx.objectStore(SESSIONS_STORE).put({
        sessionId,
        lessonId: lessonId || null,
        mimeType: mimeType || "",
        status: SESSION_STATUS.RECORDING,
        highestSequenceNumber: -1,
        chunkCount: 0,
        writeFailures: [],
        createdAt: now,
        updatedAt: now
      })
    );

    return { ok: true };
  }

  /**
   * Persists a single chunk. Never throws to the caller in a way that
   * could disrupt the live MediaRecorder — a failure here is caught,
   * recorded durably against the session record (best-effort; if even
   * that write fails, it is at least logged), and reported back via
   * the return value so the caller can additionally track it
   * in-memory for immediate visibility. This is what satisfies "never
   * silently ignore a failed chunk write."
   */
  async function putChunk({ sessionId, sequenceNumber, data }) {
    try {
      const db = await openDatabase();
      const tx = db.transaction([CHUNKS_STORE, SESSIONS_STORE], "readwrite");

      tx.objectStore(CHUNKS_STORE).put({
        sessionId,
        sequenceNumber,
        data,
        persistedAt: new Date().toISOString()
      });

      const sessionsStore = tx.objectStore(SESSIONS_STORE);
      const existing = await promisifyRequest(sessionsStore.get(sessionId));
      if (existing) {
        sessionsStore.put({
          ...existing,
          highestSequenceNumber: Math.max(existing.highestSequenceNumber, sequenceNumber),
          chunkCount: (existing.chunkCount || 0) + 1,
          updatedAt: new Date().toISOString()
        });
      }

      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
      });

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      try {
        const db = await openDatabase();
        const tx = db.transaction([SESSIONS_STORE], "readwrite");
        const sessionsStore = tx.objectStore(SESSIONS_STORE);
        const existing = await promisifyRequest(sessionsStore.get(sessionId));
        if (existing) {
          const writeFailures = Array.isArray(existing.writeFailures) ? existing.writeFailures : [];
          writeFailures.push({
            sequenceNumber,
            error: message,
            timestamp: new Date().toISOString()
          });
          sessionsStore.put({ ...existing, writeFailures, updatedAt: new Date().toISOString() });
        }
      } catch (recordError) {
        // Last resort — even the failure-recording write failed.
        console.error(
          `TeachAssist RecordingChunkStore: could not record a chunk-write failure for session ${sessionId}, sequence ${sequenceNumber}:`,
          recordError
        );
      }

      console.error(
        `TeachAssist RecordingChunkStore: chunk write failed for session ${sessionId}, sequence ${sequenceNumber}:`,
        error
      );

      return { ok: false, error: message };
    }
  }

  /**
   * Reads back every chunk for a session, in strict sequence order,
   * and detects gaps rather than silently producing an incomplete
   * recording. WebM/Opus chunks from MediaRecorder are only valid
   * when concatenated in original order starting from sequence 0 —
   * a gap means a byte-range of audio is genuinely missing, not just
   * out of order.
   */
  async function getChunksForSession(sessionId) {
    const db = await openDatabase();
    const tx = db.transaction([CHUNKS_STORE, SESSIONS_STORE], "readonly");

    const index = tx.objectStore(CHUNKS_STORE).index("sessionId");
    const records = await promisifyRequest(index.getAll(IDBKeyRange.only(sessionId)));
    records.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    const sessionRecord = await promisifyRequest(
      tx.objectStore(SESSIONS_STORE).get(sessionId)
    );

    const gaps = [];
    const expectedCount =
      sessionRecord && sessionRecord.highestSequenceNumber >= 0
        ? sessionRecord.highestSequenceNumber + 1
        : records.length;

    for (let i = 0; i < expectedCount; i++) {
      if (!records[i] || records[i].sequenceNumber !== i) {
        gaps.push(i);
      }
    }

    return {
      chunks: records.map((r) => r.data),
      chunkCount: records.length,
      expectedCount,
      gaps,
      writeFailures: (sessionRecord && sessionRecord.writeFailures) || [],
      mimeType: (sessionRecord && sessionRecord.mimeType) || "audio/webm",
      status: (sessionRecord && sessionRecord.status) || null
    };
  }

  async function getSessionStatus(sessionId) {
    const db = await openDatabase();
    const tx = db.transaction([SESSIONS_STORE], "readonly");
    return promisifyRequest(tx.objectStore(SESSIONS_STORE).get(sessionId)) || null;
  }

  /**
   * Phase 2: every durable session record, for background.js's
   * startup crash-recovery scan to find sessions still marked
   * "recording" — the signature of a session whose MediaRecorder was
   * actively writing when the offscreen document/browser disappeared
   * before a normal stop could run. Not a second representation of
   * anything — reads the same SESSIONS_STORE every other function
   * here already uses.
   */
  async function listSessions() {
    const db = await openDatabase();
    const tx = db.transaction([SESSIONS_STORE], "readonly");
    return promisifyRequest(tx.objectStore(SESSIONS_STORE).getAll());
  }

  /**
   * Updates the durable status field used for recovery idempotency —
   * a second recovery attempt (a retried tab-removed event, a manual
   * retry, a second service-worker instance) checks this before doing
   * any work, so duplicate recovery can never produce a duplicate
   * lesson.webm or a duplicate transcription job.
   */
  async function markSessionStatus(sessionId, status, extra = {}) {
    const db = await openDatabase();
    const tx = db.transaction([SESSIONS_STORE], "readwrite");
    const store = tx.objectStore(SESSIONS_STORE);
    const existing = await promisifyRequest(store.get(sessionId));

    if (!existing) return { ok: false, reason: "SESSION_NOT_FOUND" };

    store.put({
      ...existing,
      ...extra,
      status,
      updatedAt: new Date().toISOString()
    });

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    return { ok: true };
  }

  /**
   * Deletes all chunk data and the session record for a session. Only
   * ever called after the resulting lesson.webm has been created AND
   * verified downstream (never merely because a stop was requested,
   * and never tied to transcription or AI-summary success/failure —
   * those are independent, later stages that already have their own
   * retry paths against the saved audio artifact).
   */
  async function deleteChunksForSession(sessionId) {
    const db = await openDatabase();
    const tx = db.transaction([CHUNKS_STORE, SESSIONS_STORE], "readwrite");

    const index = tx.objectStore(CHUNKS_STORE).index("sessionId");
    const keysRequest = index.getAllKeys(IDBKeyRange.only(sessionId));
    const keys = await promisifyRequest(keysRequest);

    const chunksStore = tx.objectStore(CHUNKS_STORE);
    keys.forEach((key) => chunksStore.delete(key));

    tx.objectStore(SESSIONS_STORE).delete(sessionId);

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    return { ok: true, deletedChunkCount: keys.length };
  }

  return {
    SESSION_STATUS,
    initSession,
    putChunk,
    getChunksForSession,
    getSessionStatus,
    listSessions,
    markSessionStatus,
    deleteChunksForSession
  };
})();
