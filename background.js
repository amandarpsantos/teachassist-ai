importScripts(
  "services/lesson-db.js",
  "services/recording-chunk-store.js",
  "services/logging-service.js",
  "services/artifact-service.js",
  "services/job-service.js",
  "services/lesson-service.js",
  "services/meeting-service.js",
  "services/recording-session-service.js",
  "services/recorder-service.js"
);

// ---- Diagnostic-only instrumentation (temporary) ----
// Central collector for the "End call for everyone" recording-loss
// investigation. Receives entries from content.js and offscreen.js
// (which can't share memory with each other or survive a service
// worker restart) and persists every entry immediately to
// chrome.storage.local so the timeline survives across service worker
// restarts during a long class. Capped to the most recent 1000
// entries. None of this affects recording/start/stop behavior — it
// only reads and logs. Safe to remove once the root cause is
// confirmed.
const DIAG_LOG_MAX_ENTRIES = 1000;

// Phase 2, Part E: the single shared 1000-entry FIFO above is what let
// a runaway recording's own chunk-checkpoint spam evict the evidence
// of its own root cause during the original Leonardo-class
// investigation. Split into two independently-capped buffers by event
// name — high-frequency "verbose" events (right now, only
// mediarecorder_chunk_checkpoint) can no longer push low-frequency
// "lifecycle" events (starts, stops, mismatches, watchdog activity,
// track-ended recovery, errors) out of the buffer, no matter how long
// or noisy a single session gets. Existing event names are unchanged;
// this only changes which storage key an entry is written to.
const DIAG_LOG_VERBOSE_EVENT_NAMES = new Set([
  "mediarecorder_chunk_checkpoint"
]);
const DIAG_LOG_LIFECYCLE_MAX_ENTRIES = DIAG_LOG_MAX_ENTRIES;
const DIAG_LOG_VERBOSE_MAX_ENTRIES = DIAG_LOG_MAX_ENTRIES;
const DIAG_LOG_LIFECYCLE_KEY = "taDiagLogLifecycle";
const DIAG_LOG_VERBOSE_KEY = "taDiagLogVerbose";
// Legacy single-buffer key from before this split. No longer written
// to, but intentionally left readable nowhere else in this file —
// TA_DIAG_DUMP synthesizes its backward-compatible `log` field from
// the two new buffers instead, so nothing downstream needs to know
// the split happened.

function diagLog(event, detail = {}) {
  const entry = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    context: "background",
    event,
    detail
  };
  console.log("[TA-DIAG]", entry);
  recordDiagEntry(entry).catch((error) => {
    console.warn("TeachAssist: could not persist diagnostic log entry:", error);
  });
}

// Serializes every diagnostic write behind a single in-memory queue so
// two concurrent recordDiagEntry() calls can never both read the same
// stale taDiagLog snapshot and overwrite each other's entry (the
// unlocked get() -> modify -> set() cycle this replaces was a
// confirmed lost-update race — see the diagnostic-logging
// investigation). `diagLogQueue` always resolves, never rejects: each
// write's own failure is caught and logged where it happens, and the
// queue itself is reset to that caught (resolved) promise, so one
// failed write can never permanently block or poison every write that
// comes after it.
let diagLogQueue = Promise.resolve();

function recordDiagEntry(entry) {
  const write = diagLogQueue.then(() => writeDiagEntry(entry));
  diagLogQueue = write.catch((error) => {
    console.error("TeachAssist: diagnostic log write failed:", error);
  });
  return write;
}

function isVerboseDiagEvent(event) {
  return DIAG_LOG_VERBOSE_EVENT_NAMES.has(event);
}

async function writeDiagEntry(entry) {
  const verbose = isVerboseDiagEvent(entry.event);
  const storageKey = verbose ? DIAG_LOG_VERBOSE_KEY : DIAG_LOG_LIFECYCLE_KEY;
  const maxEntries = verbose ? DIAG_LOG_VERBOSE_MAX_ENTRIES : DIAG_LOG_LIFECYCLE_MAX_ENTRIES;

  const data = await chrome.storage.local.get([storageKey]);
  const log = Array.isArray(data[storageKey]) ? data[storageKey] : [];
  log.push(entry);
  if (log.length > maxEntries) {
    log.splice(0, log.length - maxEntries);
  }
  await chrome.storage.local.set({ [storageKey]: log });
}

// ---- Phase 2, Part B: crash recovery from durable chunk checkpoints ----
//
// Runs once at every service-worker startup (including after a real
// browser crash, since chrome.storage.local and IndexedDB both
// survive that — only offscreen.js's in-memory activeSession does
// not). Finds any durable RecordingChunkStore session that still
// says "recording" and is genuinely NOT the current live recording
// (confirmed via the same authoritative query Part A/Part D use),
// then reconstructs it via offscreen.js's recoverSessionFromDurableChunks()
// and feeds the result into the exact same handleOffscreenStopComplete()
// path a normal successful stop already uses — no parallel
// finalization logic.
async function recoverOrphanedRecordingChunkSessions() {
  let allSessions;
  try {
    allSessions = await RecordingChunkStore.listSessions();
  } catch (error) {
    diagLog("chunk_store_recovery_scan_failed", { error: String(error) });
    return;
  }

  // Candidates: still "recording" (never reached a normal stop) or
  // "recovery_in_progress" (a previous recovery attempt was itself
  // interrupted, e.g. by a second crash) — both are retry-eligible.
  // artifact-service.js's createArtifact() looks up any existing
  // artifact by (lessonId, artifactType) and reuses/updates it rather
  // than duplicating, which is what makes retrying an interrupted
  // recovery safe rather than merely convenient.
  const candidates = (allSessions || []).filter(
    (s) =>
      s.status === RecordingChunkStore.SESSION_STATUS.RECORDING ||
      s.status === RecordingChunkStore.SESSION_STATUS.RECOVERY_IN_PROGRESS
  );

  for (const durableSession of candidates) {
    await recoverOneOrphanedSession(durableSession).catch((error) => {
      diagLog("chunk_store_recovery_session_threw", {
        sessionId: durableSession.sessionId,
        error: String(error)
      });
    });
  }
}

async function recoverOneOrphanedSession(durableSession) {
  const { sessionId, lessonId } = durableSession;

  // Not a crash at all if offscreen.js is still actively recording
  // this exact session right now (e.g. the service worker itself
  // restarted mid-recording, which does not affect the offscreen
  // document or its MediaRecorder).
  const currentlyActive = await queryOffscreenActiveSession();
  if (currentlyActive && currentlyActive.sessionId === sessionId) {
    diagLog("chunk_store_recovery_skipped_still_live", { sessionId });
    return;
  }

  diagLog("chunk_store_recovery_started", { sessionId, lessonId: lessonId || null });

  // Idempotency guard, written durably BEFORE any risky work below —
  // a second startup (or this same scan running twice) sees this
  // status, not "recording", and skips straight past the filter
  // above.
  await RecordingChunkStore.markSessionStatus(
    sessionId,
    RecordingChunkStore.SESSION_STATUS.RECOVERY_IN_PROGRESS
  );

  await ensureOffscreenDocument();

  let recoveryResult;
  try {
    recoveryResult = await chrome.runtime.sendMessage({
      type: "TA_OFFSCREEN_RECOVER_SESSION",
      sessionId,
      lessonId: lessonId || null
    });
  } catch (error) {
    recoveryResult = { ok: false, reason: "RECOVER_MESSAGE_FAILED", error: String(error) };
  }

  if (!recoveryResult || !recoveryResult.ok) {
    diagLog("chunk_store_recovery_failed", {
      sessionId,
      reason: recoveryResult?.reason || "UNKNOWN",
      error: recoveryResult?.error || null
    });
    await RecordingChunkStore.markSessionStatus(
      sessionId,
      RecordingChunkStore.SESSION_STATUS.RECOVERY_FAILED
    );
    if (lessonId) {
      await markSessionNeedsAttention(lessonId, "RECORDING_RECOVERY_FAILED", {
        sessionId,
        reason: recoveryResult?.reason || "UNKNOWN"
      }).catch(() => {});
    }
    return;
  }

  // Reuse the exact same pipeline a normal successful stop already
  // goes through — download, finalizeSuccessfulStop(), pending-session
  // metadata — rather than a second, parallel implementation.
  pendingStopContext.set(sessionId, { stopReason: "crash_recovery" });
  await handleOffscreenStopComplete({ sessionId, result: recoveryResult });

  if (Array.isArray(recoveryResult.gaps) && recoveryResult.gaps.length > 0) {
    // handleOffscreenStopComplete() above will have persisted this as
    // a normal-looking successful lesson — this call makes the gap
    // visible rather than silently presenting a partial recording as
    // complete, per the explicit "do not pretend the recording is
    // complete" requirement.
    diagLog("chunk_store_recovery_had_gaps", {
      sessionId,
      gapCount: recoveryResult.gaps.length,
      chunkCount: recoveryResult.chunkCount,
      expectedCount: recoveryResult.expectedCount
    });
    if (lessonId) {
      await markSessionNeedsAttention(lessonId, "RECORDING_RECOVERED_WITH_GAPS", {
        sessionId,
        gapCount: recoveryResult.gaps.length,
        chunkCount: recoveryResult.chunkCount,
        expectedCount: recoveryResult.expectedCount
      }).catch(() => {});
    }
  }

  await RecordingChunkStore.markSessionStatus(
    sessionId,
    RecordingChunkStore.SESSION_STATUS.RECOVERED
  );

  try {
    await RecordingChunkStore.deleteChunksForSession(sessionId);
  } catch (error) {
    diagLog("chunk_store_recovery_cleanup_failed", { sessionId, error: String(error) });
  }

  diagLog("chunk_store_recovery_completed", { sessionId, lessonId: lessonId || null });
}

diagLog("service_worker_started", {});

recoverOrphanedRecordingChunkSessions().catch((error) => {
  diagLog("chunk_store_recovery_scan_threw", { error: String(error) });
});

// ---- Phase 2, Part B: orphaned-recording watchdog ----
//
// Historical evidence (the Leonardo-class investigation) showed a
// MediaRecorder can be left in "recording" state for hours after the
// class should have ended, if the stop that should have caught it is
// ever missed. This is the backstop: independent of every other stop
// trigger, it periodically checks whether the recording offscreen.js
// actually has active has been running longer than a sane ceiling,
// and if so, stops it through the exact same canonical stopRecorder()
// path every other stop trigger already uses.
//
// chrome.alarms, not setInterval: MV3 service workers can be
// suspended after ~30s idle, which would silently kill a setInterval
// timer. chrome.alarms are scheduled by the browser itself, not the
// worker's own memory, so re-registering the same alarm name on every
// worker startup (below, unconditionally) is what keeps this alive
// across restarts rather than a single setInterval that dies with the
// first suspension.
const RECORDING_MAX_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours
const RECORDING_WATCHDOG_ALARM_NAME = "ta-recording-watchdog";
const RECORDING_WATCHDOG_CHECK_INTERVAL_MINUTES = 5;

chrome.alarms.create(RECORDING_WATCHDOG_ALARM_NAME, {
  periodInMinutes: RECORDING_WATCHDOG_CHECK_INTERVAL_MINUTES
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECORDING_WATCHDOG_ALARM_NAME) return;
  checkRecordingWatchdog().catch((error) => {
    console.error("TeachAssist: recording watchdog check failed:", error);
  });
});

async function checkRecordingWatchdog() {
  const activeSession = await queryOffscreenActiveSession();
  if (!activeSession || !activeSession.sessionId) return;
  if (activeSession.mediaRecorderState !== "recording") return;
  if (activeSession.stopping) return;

  if (!activeSession.startTime) {
    // Should not happen in normal operation (startTime is set at
    // session creation, before the recorder ever starts) — logged so
    // a future regression here is visible instead of silently
    // disabling the watchdog for that session.
    diagLog("watchdog_check_missing_start_time", { sessionId: activeSession.sessionId });
    return;
  }

  const startedAtMs = Date.parse(activeSession.startTime);
  if (!Number.isFinite(startedAtMs)) return;

  const elapsedMs = Date.now() - startedAtMs;
  if (elapsedMs < RECORDING_MAX_DURATION_MS) return;

  diagLog("watchdog_max_duration_exceeded", {
    sessionId: activeSession.sessionId,
    elapsedMs,
    maxDurationMs: RECORDING_MAX_DURATION_MS
  });

  // Same canonical entry point every other stop trigger uses —
  // inFlightStops dedup, offscreen.js's own finalizationPromises/
  // finalizedResults, and processedStopCompletions all apply exactly
  // as they do for a manual or meeting-ended stop. No second
  // stop/finalization mechanism is introduced.
  const result = await stopRecorder({
    sessionId: activeSession.sessionId,
    stopReason: "watchdog_max_duration"
  });

  diagLog("watchdog_stop_result", {
    sessionId: activeSession.sessionId,
    ok: Boolean(result?.ok),
    reason: result?.reason || null
  });
}

// ---- Phase 2, Part C: tab-track-ended safety (background half) ----
//
// offscreen.js notifies this listener when the tab-capture track
// specifically (never the microphone track) ends. A grace period
// gives a normal meeting-ended/manual stop the chance to resolve the
// session first; only if the session is STILL active after the grace
// period does this trigger a stop of its own, through the same
// stopRecorder() path as everything else.
const TAB_TRACK_ENDED_GRACE_PERIOD_MS = 45000; // within the requested 30-60s range
const tabTrackEndedGraceTimers = new Map(); // sessionId -> timeout handle

async function handleOffscreenTrackEnded(message) {
  const sessionId = message?.sessionId || null;
  const label = message?.label || null;
  if (!sessionId || label !== "tab") return;

  if (tabTrackEndedGraceTimers.has(sessionId)) {
    // A second "ended" event for the same track/session (should be
    // rare) must not stack a second timer or a second eventual stop
    // attempt for the same session.
    return;
  }

  diagLog("tab_track_ended_grace_period_started", {
    sessionId,
    graceMs: TAB_TRACK_ENDED_GRACE_PERIOD_MS
  });

  const timer = setTimeout(() => {
    tabTrackEndedGraceTimers.delete(sessionId);
    resolveTabTrackEndedGracePeriod(sessionId).catch((error) => {
      console.error("TeachAssist: tab-track-ended grace period resolution failed:", error);
    });
  }, TAB_TRACK_ENDED_GRACE_PERIOD_MS);

  tabTrackEndedGraceTimers.set(sessionId, timer);
}

async function resolveTabTrackEndedGracePeriod(sessionId) {
  const activeSession = await queryOffscreenActiveSession();

  if (!activeSession || activeSession.sessionId !== sessionId) {
    // Already stopped by another mechanism (meeting-ended, manual
    // stop, the watchdog) during the grace period — nothing to do,
    // and nothing was cleared here that another path didn't already
    // clear itself.
    diagLog("tab_track_ended_grace_period_noop", { sessionId });
    return;
  }

  diagLog("tab_track_ended_stop_triggered", { sessionId });

  const result = await stopRecorder({ sessionId, stopReason: "tab_track_ended" });

  diagLog("tab_track_ended_stop_result", {
    sessionId,
    ok: Boolean(result?.ok),
    reason: result?.reason || null
  });
}

TeachAssistDB.initializeDatabase()
  .then(async () => {
    await RecordingSessionService.initialize();
    await JobService.initialize();

    console.log(
      "TeachAssistDB initialized successfully."
    );

    console.log(
      "RecordingSessionService initialized successfully."
    );

    console.log(
      "JobService initialized successfully."
    );
  })
  .catch(error => {
    console.error(
      "TeachAssist initialization failed:",
      error
    );
  });


const ICONS = {
  noMeeting: {
    16: "icons/no-meeting/icon16.png",
    32: "icons/no-meeting/icon32.png",
    48: "icons/no-meeting/icon48.png",
    128: "icons/no-meeting/icon128.png"
  },
  active: {
    16: "icons/active/icon16.png",
    32: "icons/active/icon32.png",
    48: "icons/active/icon48.png",
    128: "icons/active/icon128.png"
  },
  recording: {
    16: "icons/recording/icon16.png",
    32: "icons/recording/icon32.png",
    48: "icons/recording/icon48.png",
    128: "icons/recording/icon128.png"
  }
};

async function setIconForState(state) {
  const path = ICONS[state] || ICONS.noMeeting;
  try {
    await chrome.action.setIcon({ path });
  } catch (error) {
    console.warn("TeachAssist could not set icon:", error);
  }
}

async function getPendingSessions() {
  const data = await chrome.storage.local.get(["taPendingSessions"]);
  return Array.isArray(data.taPendingSessions) ? data.taPendingSessions : [];
}

async function setPendingSessions(sessions) {
  await chrome.storage.local.set({ taPendingSessions: sessions });
}

async function getPendingGroups() {
  const data = await chrome.storage.local.get(["taPendingGroups"]);
  return Array.isArray(data.taPendingGroups) ? data.taPendingGroups : [];
}

async function setPendingGroups(groups) {
  await chrome.storage.local.set({ taPendingGroups: groups });
}

async function getPendingCount() {
  const groups = await getPendingGroups();
  if (groups.length) {
    return groups.filter((g) => g?.status !== "deleted").length;
  }

  const sessions = await getPendingSessions();
  const groupIds = new Set();
  sessions.forEach((s) => {
    if (s?.groupId) groupIds.add(s.groupId);
  });
  if (groupIds.size) return groupIds.size;
  return sessions.filter((s) => s?.statusJson?.state !== "deleted").length;
}

function safeSegment(value = "") {
  return String(value)
    .replace(/[^a-z0-9_\-\.]+/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "lesson";
}

function dataUrlForJson(object) {
  const json = JSON.stringify(object, null, 2);
  return "data:application/json;charset=utf-8," + encodeURIComponent(json);
}

async function downloadJson(filename, object, conflictAction = "overwrite") {
  try {
    await chrome.downloads.download({
      url: dataUrlForJson(object),
      filename,
      saveAs: false,
      conflictAction
    });
    return { ok: true };
  } catch (error) {
    console.warn("TeachAssist metadata download failed:", error);
    return { ok: false, error: String(error) };
  }
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  if (chrome.offscreen?.hasDocument) {
    const hasDocument = await chrome.offscreen.hasDocument();
    // The clearest possible signal for this investigation: if
    // hasDocument() is ever false while we believed a recording was
    // still in progress, that alone proves the offscreen document was
    // destroyed at some point — no correlation with other logs needed.
    diagLog("ensure_offscreen_document_checked", { hasDocument });
    if (hasDocument) return;
  }

  try {
    diagLog("ensure_offscreen_document_creating", {});
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ["USER_MEDIA"],
      justification: "Record microphone and meeting tab audio for TeachAssist AI lessons."
    });
    diagLog("ensure_offscreen_document_created", {});
  } catch (error) {
    // If the document already exists, Chrome may throw. Safe to continue.
    if (!String(error).includes("Only a single offscreen document")) {
      diagLog("ensure_offscreen_document_create_failed", { error: String(error) });
      throw error;
    }
    diagLog("ensure_offscreen_document_create_raced", { error: String(error) });
  }
}

// Phase 2, Part A: the single shared way background.js asks offscreen.js
// what is ACTUALLY recording right now, instead of trusting a
// caller-supplied sessionId. Used by the automatic-stop mismatch
// recovery below, the Part B watchdog, and the Part C tab-track-ended
// grace-period resolution — one query, three callers, no separate
// session-state system. Deliberately does not call
// ensureOffscreenDocument(): creating an offscreen document just to
// ask it "is anything active" would be a side effect this read-only
// query should never have — if no document exists, there is
// definitionally no active session.
async function queryOffscreenActiveSession() {
  if (chrome.offscreen?.hasDocument) {
    const hasDocument = await chrome.offscreen.hasDocument();
    if (!hasDocument) return null;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "TA_OFFSCREEN_GET_ACTIVE_SESSION" });
    return response?.activeSession || null;
  } catch (error) {
    diagLog("offscreen_active_session_query_failed", { error: String(error) });
    return null;
  }
}

function dataUrlForBlobArrayBuffer(arrayBuffer, mimeType = "audio/webm") {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

async function downloadRecording(filename, url) {
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "overwrite"
    });
    return { ok: true, downloadId };
  } catch (error) {
    console.warn("TeachAssist recording download failed:", error);
    return { ok: false, error: String(error) };
  }
}

// Phase 1 defense-in-depth: mirrors the inFlightStops pattern below,
// keyed by sender tab ID (not session ID) because no session ID has
// been validated yet at this point in a start attempt — only the tab
// is known. If more than one TA_START_REAL_RECORDING message for the
// same tab reaches background.js concurrently (e.g. a duplicate
// message delivery, or a start race that content.js's own
// startInFlight lock did not catch), only the first actually calls
// RecorderService.startRecording(); every other caller just awaits
// and receives that same result — it does not initiate a second real
// recording. This is in addition to, not a replacement for,
// content.js's start-side lock, which is the primary guard.
const inFlightStarts = new Map();

async function startRecorder(senderTabId, payload = {}) {
  if (senderTabId && inFlightStarts.has(senderTabId)) {
    return inFlightStarts.get(senderTabId);
  }

  const startPromise = performStart(senderTabId, payload);

  if (senderTabId) {
    inFlightStarts.set(senderTabId, startPromise);
    startPromise.finally(() => {
      if (inFlightStarts.get(senderTabId) === startPromise) {
        inFlightStarts.delete(senderTabId);
      }
    });
  }

  return startPromise;
}

async function performStart(senderTabId, payload = {}) {
  if (!senderTabId) {
    return {
      ok: false,
      reason: "NO_TAB_ID"
    };
  }

  await ensureOffscreenDocument();

  // registerSessionMetadata() always runs before this (content.js
  // calls TA_REGISTER_SESSION_METADATA, then TA_START_REAL_RECORDING),
  // so the session's permanent lessonId already exists in storage by
  // this point. offscreen.js can't look this up itself — chrome.storage
  // isn't available there — so it's handed over here, once, as a small
  // id, and cached on the session for finalizeStop() to use later when
  // it saves the artifact directly to IndexedDB.
  let lessonId = null;
  if (payload.sessionId) {
    const sessions = await getPendingSessions();
    const record = sessions.find((s) => s.sessionId === payload.sessionId);
    lessonId = record?.lessonJson?.lessonId || null;
  }

  diagLog("lesson_id_available_at_recording_start", {
    sessionId: payload.sessionId || null,
    lessonId,
    available: Boolean(lessonId)
  });

  return RecorderService.startRecording({
    tabId: senderTabId,
    sessionId: payload.sessionId,
    lessonId,
    mode: payload.mode || "mixed",
    mimeType: "audio/webm;codecs=opus"
  });
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-recording") {
    return;
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!activeTab?.id) {
    return;
  }

  // Phase 2.6: the keyboard shortcut previously messaged whatever tab
  // happened to be active unconditionally — if that tab wasn't a
  // supported Meet/Teams page (or its content script hadn't finished
  // loading yet), chrome.tabs.sendMessage() throws "Could not
  // establish connection. Receiving end does not exist.", confusing
  // and with no feedback that the shortcut simply had nothing to act
  // on. Same guard already used by TA_GET_ACTIVE_TAB_STATUS's handler
  // — if the active tab isn't a supported meeting URL, there's
  // nothing to toggle, so do nothing rather than throw.
  if (!MeetingService.isSupportedMeetingUrl(activeTab.url)) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(activeTab.id, {
        type: "TA_TOGGLE_RECORDING"
    });
  } catch (error) {
    console.error(
      "TeachAssist command failed:",
      error
    );
  }
});

// stopRecorder() is now the single canonical finalization entry point
// for all three termination methods (hotkey/popup, meeting-end, and
// chrome.tabs.onRemoved on tab close). content.js is one caller among
// several — it is no longer required to survive for a session to be
// finalized.
//
// A per-sessionId in-flight map ensures that if more than one caller
// tries to stop the exact same session at nearly the same time (e.g.
// content.js's pagehide handler and chrome.tabs.onRemoved both firing
// when a meeting tab is closed), only the first call actually performs
// the stop; every other caller just awaits and receives that same
// result. This is in addition to — not a replacement for — the
// existing activeSession/session.stopping/stoppingSessionIds
// dedup inside offscreen.js and content.js, which is unchanged.
const inFlightStops = new Map();

async function stopRecorder(payload = {}) {
  const sessionId = payload.sessionId || null;

  if (sessionId && inFlightStops.has(sessionId)) {
    return inFlightStops.get(sessionId);
  }

  const stopPromise = performStop(payload);

  if (sessionId) {
    inFlightStops.set(sessionId, stopPromise);
    stopPromise.finally(() => {
      if (inFlightStops.get(sessionId) === stopPromise) {
        inFlightStops.delete(sessionId);
      }
    });
  }

  return stopPromise;
}

function recordAlreadyFinalized(record) {
  return Boolean(
    record &&
    record.statusJson?.state === "waiting_for_upload" &&
    record.lessonJson?.recordingFile
  );
}

// Clears the live RecordingSessionService session once a stop for it
// has been resolved (success or failure), but only when the session
// being stopped is still the one the service considers active — a
// stale/delayed stop for an older session must never clear a newer,
// currently-recording session's state. Mirrors the existing
// isStillTheActiveSession check already used by the
// TA_RECORDING_STATE_CHANGED handler below.
async function clearActiveSessionIfCurrent(sessionId, reason) {
  const currentState = await RecordingSessionService.getState();
  const isStillTheActiveSession =
    !sessionId || currentState.activeSessionId === sessionId;

  if (currentState.activeSessionId && isStillTheActiveSession) {
    await RecordingSessionService.beginStopping({ reason });
    await RecordingSessionService.markStopped({ reason });
    await RecordingSessionService.reset();
  }
}

// Persists the successful finalization bookkeeping. background.js now
// owns this once the recording data has actually been obtained and
// downloadRecording() has succeeded — content.js is no longer
// responsible for a second TA_SAVE_SESSION_METADATA call to make a
// successful stop durable. Reuses the existing saveSessionMetadata()/
// persistSessionMetadata() helpers rather than writing a second
// finalization implementation.
async function finalizeSuccessfulStop({
  sessionId,
  persistedRecord,
  groupFolderName,
  sessionFolderName,
  filename,
  mimeType,
  sizeBytes,
  expectStereo,
  stereoValidation,
  stopReason,
  stoppedAt
}) {
  const sessions = await getPendingSessions();
  const record = sessions.find((s) => s.sessionId === sessionId) || persistedRecord;

  if (!record) {
    console.warn("TeachAssist: no persisted session record found to finalize for", sessionId);
    return { ok: false, reason: "SESSION_RECORD_NOT_FOUND" };
  }

  const startedAt = record.lessonJson?.startedAt;
  // Duration is computed here from persisted wall-clock timestamps
  // rather than trusted from content.js's in-tab timer, so
  // finalization duration is correct even when content.js never
  // survives to report it (e.g. the tab-close path).
  const durationSeconds = startedAt
    ? Math.max(0, Math.round((Date.parse(stoppedAt) - Date.parse(startedAt)) / 1000))
    : (record.lessonJson?.durationSeconds || 0);

  record.lessonJson = {
    ...record.lessonJson,
    stoppedAt,
    durationSeconds,
    stopReason,
    recordingFilename: "lesson.webm",
    recordingFile: { filename, mimeType, sizeBytes },
    recordingSource: "mixed",
    expectStereo: Boolean(expectStereo),
    stereoValidation: stereoValidation || null
  };

  record.statusJson = {
    ...record.statusJson,
    state: "waiting_for_upload",
    currentStep:
      stopReason === "manual_stop"
        ? "Mixed recording saved"
        : `Mixed recording saved after automatic stop: ${stopReason}`,
    lastUpdated: stoppedAt,
    errors:
      expectStereo && stereoValidation && !stereoValidation.ok
        ? [
            {
              reason: "STEREO_CHANNEL_SEPARATION_FAILED",
              error:
                "Recording saved, but microphone and tab audio could not be verified as separate stereo channels " +
                `(${stereoValidation.error || "channel check failed"}). ` +
                "The audio file is still usable; channel-based speaker separation may not be reliable for this lesson.",
              timestamp: stoppedAt,
              sessionId
            }
          ]
        : []
  };

  const groups = await getPendingGroups();
  const existingGroup = groups.find((g) => g.groupId === record.groupId) || undefined;

  return saveSessionMetadata({
    groupFolderName: record.groupFolderName || groupFolderName,
    sessionFolderName: record.sessionFolderName || sessionFolderName,
    lessonJson: record.lessonJson,
    statusJson: record.statusJson,
    groupJson: existingGroup
  });
}

// Waiters for a pushed TA_OFFSCREEN_STOP_COMPLETE, keyed by sessionId.
// An array (not a single resolver) purely for defensive robustness —
// in normal operation stopRecorder()'s own inFlightStops dedup means
// there is only ever one waiter per session, but this way a caller
// that somehow bypasses that dedup still gets a correct answer
// instead of clobbering another waiter's resolver.
const pendingFinalizationWaiters = new Map();
// Context (stopReason/folder names) a performStop() call knew about
// when it started, so the TA_OFFSCREEN_STOP_COMPLETE handler — which
// runs independently and may not have a live performStop() call
// waiting on it at all — can still persist the file correctly.
const pendingStopContext = new Map();

function waitForOffscreenStopComplete(sessionId, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const waiter = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      const waiters = pendingFinalizationWaiters.get(sessionId);
      if (waiters) {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        if (waiters.length === 0) pendingFinalizationWaiters.delete(sessionId);
      }
      diagLog("wait_for_finalization_timeout", { sessionId, timeoutMs });
      resolve({ ok: false, reason: "STOP_RESPONSE_TIMEOUT" });
    }, timeoutMs);

    if (!pendingFinalizationWaiters.has(sessionId)) {
      pendingFinalizationWaiters.set(sessionId, []);
    }
    pendingFinalizationWaiters.get(sessionId).push(waiter);
  });
}

// The single place that turns a settled offscreen.js stop result into
// a saved file + persisted metadata (or a needs_attention-worthy
// failure). Runs exactly once per session, driven by the
// TA_OFFSCREEN_STOP_COMPLETE push from offscreen.js — not by whichever
// caller happens to still be waiting, so the successful file is saved
// even if the original performStop() call already gave up for any
// reason.
// Tracks every sessionId whose completion has already been fully
// processed — downloaded and persisted (or recorded as a genuine
// failure). This is a defense-in-depth guard: offscreen.js's own
// finalizationPromises/finalizedResults already ensure only one
// TA_OFFSCREEN_STOP_COMPLETE is ever sent per session, but this
// guarantees that even if this handler is ever invoked twice for the
// same sessionId — a duplicate message delivery, or a future change
// upstream — the file is only ever downloaded and persisted once, and
// a later delivery can never overwrite that outcome with anything
// else. It correlates purely on sessionId, independent of the
// message's arrival order or of whether the original performStop()
// caller is still around.
const processedStopCompletions = new Map();

// Tracks each in-flight chrome.downloads download by its downloadId,
// so the single shared onChanged listener below knows which waiter
// (if any) to resolve once that specific download reaches a terminal
// state. Not the same thing as pendingFinalizationWaiters — this is
// purely about the chrome.downloads lifecycle, downstream of a stop
// already having been reported as "ok".
const activeDownloadTrackers = new Map();

chrome.downloads.onChanged.addListener((delta) => {
  const tracker = activeDownloadTrackers.get(delta.id);
  if (!tracker) return;
  if (delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
    activeDownloadTrackers.delete(delta.id);
    tracker.resolve({ state: delta.state.current, error: delta.error?.current || null });
  }
});

function waitForDownloadTerminalState(downloadId, timeoutMs = 300000) {
  return new Promise((resolve) => {
    // Check immediately first — covers the edge case where the
    // download already finished before this listener was attached
    // (realistically only possible for very short/small saves, but
    // cheap to handle correctly regardless of recording length).
    chrome.downloads.search({ id: downloadId }).then((items) => {
      const item = items && items[0];
      if (item && (item.state === "complete" || item.state === "interrupted")) {
        resolve({ state: item.state, error: item.error || null });
        return;
      }

      const timer = setTimeout(() => {
        activeDownloadTrackers.delete(downloadId);
        diagLog("wait_for_download_timeout", { downloadId, timeoutMs });
        resolve({ state: "timeout", error: null });
      }, timeoutMs);

      activeDownloadTrackers.set(downloadId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        }
      });
    }).catch(() => {
      resolve({ state: "unknown", error: "chrome.downloads.search failed" });
    });
  });
}

// Follows one download from "started" through to a terminal state,
// retrying once on a genuine failure (the failed write never touches
// the source Blob, so the same blobUrl is safe to reuse), and only
// then either releases the blob (on success) or gives up via the
// defined failure path: correct the persisted status so a failed save
// never silently looks successful, then release the blob — holding it
// forever isn't a real recovery mechanism once retries are exhausted,
// and an unbounded retained Blob is its own risk.
async function trackDownloadToCompletion({ sessionId, downloadId, blobUrl, filename, attempt = 1 }) {
  diagLog("download_started", { sessionId, downloadId, filename, attempt, retryCount: attempt - 1 });
  diagLog("download_id_received", { sessionId, downloadId, attempt });

  let outcome = await waitForDownloadTerminalState(downloadId);

  if (outcome.state === "timeout") {
    // Ambiguous — ask for the authoritative current state rather than
    // assume either success or failure.
    try {
      const items = await chrome.downloads.search({ id: downloadId });
      const item = items && items[0];
      outcome = { state: item?.state || "unknown", error: item?.error || null };
      diagLog("download_status_checked_after_timeout", { sessionId, downloadId, state: outcome.state });
    } catch (error) {
      diagLog("download_status_check_failed", { sessionId, downloadId, error: String(error) });
    }
  }

  if (outcome.state === "complete") {
    diagLog("download_state_change", { sessionId, downloadId, state: "complete", attempt, retryCount: attempt - 1 });
    sendReleaseBlobUrl(sessionId, "complete");
    return;
  }

  diagLog("download_interrupted", { sessionId, downloadId, attempt, retryCount: attempt - 1, state: outcome.state, error: outcome.error });

  if (attempt < 2) {
    diagLog("download_retry_attempted", { sessionId, downloadId, attempt: attempt + 1, retryCount: attempt });
    try {
      const retryId = await chrome.downloads.download({
        url: blobUrl,
        filename,
        saveAs: false,
        conflictAction: "overwrite"
      });
      await trackDownloadToCompletion({ sessionId, downloadId: retryId, blobUrl, filename, attempt: attempt + 1 });
      return;
    } catch (error) {
      diagLog("download_retry_failed_to_start", { sessionId, error: String(error) });
    }
  }

  // Retries exhausted (or the retry itself couldn't even start) — the
  // defined terminal failure path. The IndexedDB artifact (saved by
  // offscreen.js long before this point) is completely unaffected —
  // this only corrects the local-download status, never touches the
  // artifact.
  diagLog("download_giving_up", { sessionId, downloadId, state: outcome.state, error: outcome.error, retryCount: attempt - 1 });
  await markSessionNeedsAttention(
    sessionId,
    "Recording download failed after starting — the recording itself is still preserved and available for transcription",
    outcome.error || outcome.state || "Unknown download failure"
  );
  sendReleaseBlobUrl(sessionId, "failed_after_retry");
}

function sendReleaseBlobUrl(sessionId, reason) {
  diagLog("blob_release_requested", { sessionId, reason });
  chrome.runtime.sendMessage({ type: "TA_RELEASE_BLOB_URL", sessionId, reason }).catch(() => {});
}

async function handleOffscreenStopComplete(message) {
  const sessionId = message.sessionId;

  if (sessionId && processedStopCompletions.has(sessionId)) {
    // Already fully handled — the completed outcome for this session
    // is authoritative and immutable from here on. Don't re-download,
    // don't re-persist, just relay the same outcome to any waiter.
    diagLog("offscreen_stop_complete_duplicate_ignored", { sessionId });
    const cachedOutcome = processedStopCompletions.get(sessionId);
    const duplicateWaiters = pendingFinalizationWaiters.get(sessionId);
    if (duplicateWaiters && duplicateWaiters.length) {
      pendingFinalizationWaiters.delete(sessionId);
      duplicateWaiters.forEach((resolve) => resolve(cachedOutcome));
    }
    return;
  }

  const offscreenResult = message.result || { ok: false, reason: "MISSING_RESULT" };

  diagLog("offscreen_stop_complete_received", {
    sessionId,
    ok: offscreenResult.ok,
    reason: offscreenResult.reason || null
  });

  const context = pendingStopContext.get(sessionId) || {};
  pendingStopContext.delete(sessionId);

  let finalOutcome;

  if (!offscreenResult.ok) {
    finalOutcome = offscreenResult;
    await clearActiveSessionIfCurrent(sessionId, "recording_stop_failed");
  } else {
    const sessions = await getPendingSessions();
    const persistedRecord = sessions.find((s) => s.sessionId === sessionId) || null;

    const groupFolderName = context.groupFolderName || persistedRecord?.groupFolderName || "lesson_group";
    const sessionFolderName = context.sessionFolderName || persistedRecord?.sessionFolderName || "session_001";
    const stopReason = context.stopReason || "stopped";

    const safeGroup = safeSegment(groupFolderName);
    const safeSession = safeSegment(sessionFolderName);
    const filename = `TeachAssist AI/Pending Uploads/${safeGroup}/${safeSession}/lesson.webm`;
    const download = await downloadRecording(filename, offscreenResult.blobUrl);

    const stereoValidation = offscreenResult.stereoValidation || null;

    if (offscreenResult.expectStereo && stereoValidation && !stereoValidation.ok) {
      try {
        await LoggingService.warning({
          sessionId: sessionId || null,
          stage: "recording",
          code: "STEREO_CHANNEL_SEPARATION_FAILED",
          message:
            "Both microphone and tab audio were available, but the recorded file is not true stereo. " +
            (stereoValidation.error || "Channel separation could not be verified."),
          metadata: {
            numberOfChannels: stereoValidation.numberOfChannels,
            groupFolderName: groupFolderName || null,
            sessionFolderName: sessionFolderName || null
          }
        });
      } catch (logError) {
        console.warn("TeachAssist could not log stereo validation warning:", logError);
      }
    }

    const stoppedAt = offscreenResult.stoppedAt || new Date().toISOString();
    let metadataPersisted = false;

    if (download.ok) {
      const finalizeResult = await finalizeSuccessfulStop({
        sessionId,
        persistedRecord,
        groupFolderName: safeGroup,
        sessionFolderName: safeSession,
        filename,
        mimeType: offscreenResult.mimeType,
        sizeBytes: offscreenResult.sizeBytes,
        expectStereo: offscreenResult.expectStereo,
        stereoValidation,
        stopReason,
        stoppedAt
      });
      metadataPersisted = Boolean(finalizeResult?.ok);

      // Fire-and-forget: follows the download through to a terminal
      // state (retrying once on failure) and releases the blobUrl only
      // once that's settled — see trackDownloadToCompletion(). Doesn't
      // delay the "initiated successfully" result returned below.
      trackDownloadToCompletion({
        sessionId,
        downloadId: download.downloadId,
        blobUrl: offscreenResult.blobUrl,
        filename
      }).catch((error) => {
        console.error("TeachAssist: trackDownloadToCompletion failed:", error);
      });
    } else {
      // chrome.downloads.download() itself threw — no downloadId, so
      // there's nothing for trackDownloadToCompletion() to follow.
      // Correct the status the same way the retry-exhausted path does,
      // release the blob, and stop — the IndexedDB artifact (saved by
      // offscreen.js before this point) is completely unaffected, and
      // the transcription trigger below fires regardless.
      diagLog("download_giving_up", { sessionId, error: download.error || "download() threw before a downloadId was assigned", retryCount: 0 });
      await markSessionNeedsAttention(
        sessionId,
        "Recording download failed to start — the recording itself is still preserved and available for transcription",
        download.error || "chrome.downloads.download() failed before starting"
      );
      sendReleaseBlobUrl(sessionId, "download_start_failed");
    }

    // Fire-and-forget, and deliberately NOT inside `if (download.ok)`:
    // the IndexedDB artifact is the primary preserved copy and was
    // already saved by offscreen.js before the download was ever
    // attempted (see finalizeStop()/savePreparedAudioArtifact()). The
    // transcription/dashboard pipeline must not depend on the local
    // chrome.downloads save succeeding — it reads the artifact back
    // from IndexedDB on its own, independent of this.
    finalizeAndTranscribeRecording({
      sessionId: sessionId || null,
      stoppedAt
    }).catch((error) => {
      console.error("TeachAssist transcription pipeline failed:", error);
    });

    await clearActiveSessionIfCurrent(sessionId, "recording_stopped");

    finalOutcome = {
      ok: download.ok,
      filename,
      sizeBytes: offscreenResult.sizeBytes || null,
      mimeType: offscreenResult.mimeType || "audio/webm",
      download,
      expectStereo: offscreenResult.expectStereo || false,
      stereoValidation,
      metadataPersisted
    };
  }

  if (sessionId) {
    // Recorded once, here, before any waiter is notified — this is
    // the exact instant this session's outcome becomes immutable for
    // every future TA_OFFSCREEN_STOP_COMPLETE delivery.
    processedStopCompletions.set(sessionId, finalOutcome);
  }

  const waiters = pendingFinalizationWaiters.get(sessionId);
  if (waiters && waiters.length) {
    pendingFinalizationWaiters.delete(sessionId);
    waiters.forEach((resolve) => resolve(finalOutcome));
  } else {
    diagLog("offscreen_stop_complete_no_waiter", { sessionId });
  }
}

// Phase 2, Part A: stop reasons that originate from something other
// than the user directly clicking/pressing Stop for a specific
// session. Only these are eligible for automatic mismatch recovery —
// a manual stop must always stay tied to the session the user
// actually asked to stop; if that ever mismatches, log it, never
// auto-redirect it to a different, unrelated session.
const AUTOMATIC_STOP_REASONS = new Set([
  "meeting_ended",
  "tab_closed",
  "watchdog_max_duration",
  "tab_track_ended"
]);

// For an automatic stop only, confirms the caller-supplied sessionId
// actually matches what offscreen.js reports as active, and — if it
// doesn't — resolves to the real active session instead. This is the
// exact recovery the Leonardo-class investigation showed was missing:
// a stale sessionId (e.g. from a start race resolved by Phase 1, or
// any future equivalent bug) previously caused the real, healthy
// recording to be left running indefinitely because the stop request
// was aimed at the wrong session. Never used for manual stops.
async function resolveAutomaticStopSessionId(requestedSessionId, stopReason) {
  if (!requestedSessionId || !AUTOMATIC_STOP_REASONS.has(stopReason)) {
    return requestedSessionId;
  }

  const activeSession = await queryOffscreenActiveSession();

  if (!activeSession) {
    // No active session at all — preserve existing behavior. The
    // normal NOT_RECORDING path a few lines below already handles
    // this correctly; nothing to recover here.
    return requestedSessionId;
  }

  if (activeSession.sessionId === requestedSessionId) {
    return requestedSessionId;
  }

  diagLog("automatic_stop_id_mismatch_recovered", {
    requestedSessionId,
    actualActiveSessionId: activeSession.sessionId,
    stopReason
  });

  return activeSession.sessionId;
}

async function performStop(payload = {}) {
  const requestedSessionId = payload.sessionId || null;
  const stopReason = payload.stopReason || "stopped";
  const sessionId = await resolveAutomaticStopSessionId(requestedSessionId, stopReason);

  diagLog("perform_stop_called", { sessionId, requestedSessionId, stopReason });

  // groupFolderName/sessionFolderName normally come from content.js,
  // but the tab-close path (chrome.tabs.onRemoved) calls stopRecorder()
  // directly and content.js may already be gone — fall back to the
  // record persisted at recording start (registerSessionMetadata).
  let persistedRecord = null;
  if (sessionId) {
    const sessions = await getPendingSessions();
    persistedRecord = sessions.find((s) => s.sessionId === sessionId) || null;
  }

  const groupFolderName = payload.groupFolderName || persistedRecord?.groupFolderName;
  const sessionFolderName = payload.sessionFolderName || persistedRecord?.sessionFolderName;

  if (sessionId) {
    pendingStopContext.set(sessionId, { groupFolderName, sessionFolderName, stopReason });
  }

  try {
    await ensureOffscreenDocument();
    // No retry here. This message now only asks offscreen.js to
    // acknowledge the stop (fast — it no longer waits for the Blob to
    // build), so a failure here is a real, immediate failure, not a
    // slow-finalization timeout being misread as one. Retrying that
    // misread is exactly what used to send a second stop message
    // while the first was still finalizing, which is the bug this
    // whole change fixes — so there is deliberately no retry left.
    const ack = await RecorderService.stopRecording(sessionId);

    if (!ack?.ok) {
      if (ack?.reason === "NOT_RECORDING" && recordAlreadyFinalized(persistedRecord)) {
        // A later stop attempt for a session that already finalized
        // successfully. The first successful finalization wins — this
        // is not a failure.
        pendingStopContext.delete(sessionId);
        return { ok: true, alreadyFinalized: true, sessionId };
      }

      pendingStopContext.delete(sessionId);
      await clearActiveSessionIfCurrent(sessionId, "recording_stop_failed");
      return ack || { ok: false, reason: "NO_OFFSCREEN_RESPONSE" };
    }

    if (!ack.pending) {
      // ack.ok is guaranteed true here (the !ack.ok branch above
      // already returned). A settled success came back immediately —
      // offscreen.js's cache answering a late duplicate stop whose
      // finalization already completed and was already saved by the
      // first call's TA_OFFSCREEN_STOP_COMPLETE push. Nothing further
      // to download or persist here.
      pendingStopContext.delete(sessionId);
      return { ok: true, alreadyFinalized: true, sessionId };
    }

    // Wait for the real result, pushed independently by offscreen.js
    // once the Blob is actually built — this can legitimately take
    // 15-20+ seconds for an hour-long class, which is exactly why it's
    // no longer the thing gating this message's response.
    const result = await waitForOffscreenStopComplete(sessionId);
    return result;
  } catch (error) {
    pendingStopContext.delete(sessionId);
    await clearActiveSessionIfCurrent(sessionId, "recording_stop_failed");
    return {
      ok: false,
      reason: "OFFSCREEN_STOP_FAILED",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function persistSessionMetadata(payload) {
  const { lessonJson, statusJson } = payload;

  const groupJson = payload.groupJson || {
    groupId: lessonJson?.groupId || lessonJson?.sessionId,
    meetingTitle: lessonJson?.meetingTitle || "Unknown Meeting",
    meetingPlatform: lessonJson?.meetingPlatform || "Unknown Platform",
    createdAt: lessonJson?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessions: [],
    mergeStatus: "not_decided"
  };

  const safeGroup = safeSegment(
    payload.groupFolderName || lessonJson?.groupFolderName || groupJson?.folderName || lessonJson?.sessionId || "lesson_group"
  );
  const safeSession = safeSegment(
    payload.sessionFolderName || lessonJson?.sessionFolderName || `session_${String((groupJson.sessions || []).length + 1).padStart(3, "0")}`
  );

  const groupBase = `TeachAssist AI/Pending Uploads/${safeGroup}`;
  const sessionBase = `${groupBase}/${safeSession}`;

  const sessions = await getPendingSessions();
  const existingIndex = sessions.findIndex((s) => s.sessionId === lessonJson.sessionId);
  const record = {
    sessionId: lessonJson.sessionId,
    groupId: groupJson.groupId,
    groupFolderName: safeGroup,
    sessionFolderName: safeSession,
    lessonJson,
    statusJson,
    savedAt: new Date().toISOString()
  };
  if (existingIndex >= 0) sessions[existingIndex] = record;
  else sessions.push(record);
  await setPendingSessions(sessions);

  const groups = await getPendingGroups();
  const existingGroupIndex = groups.findIndex((g) => g.groupId === groupJson.groupId);
  const uniqueSessions = Array.from(new Set([...(groupJson.sessions || []), safeSession]));
  const groupRecord = {
    ...groupJson,
    folderName: safeGroup,
    sessions: uniqueSessions,
    updatedAt: new Date().toISOString(),
    status: "pending_upload"
  };
  if (existingGroupIndex >= 0) groups[existingGroupIndex] = groupRecord;
  else groups.push(groupRecord);
  await setPendingGroups(groups);

  return {
    ok: true,
    groupRecord,
    record,
    groupBase,
    sessionBase,
    groupFolderName: safeGroup,
    sessionFolderName: safeSession,
    pendingLessons: await getPendingCount()
  };
}

async function registerSessionMetadata(payload) {
  /*
   * Register session metadata in chrome.storage only.
   * This protects the session for tab-close recovery
   * without creating visible downloads on Start.
   */
  const persisted =
    await persistSessionMetadata(payload);

  if (!persisted?.ok) {
    return persisted;
  }

  const lessonJson =
  persisted.record?.lessonJson || {};

let permanentLesson = null;

if (!lessonJson.lessonId) {
  permanentLesson = await LessonService.startLesson({
    studentId: null,
    studentName:
      lessonJson.displayName ||
      lessonJson.meetingTitle ||
      "Unknown Student",

    classTitle:
      lessonJson.lessonTitle ||
      lessonJson.meetingTitle ||
      "English Class",

    classProgram:
      lessonJson.classType || null,

    platform:
      lessonJson.meetingPlatform || null,

    meetingUrl: null,

    startedAt:
      lessonJson.startedAt ||
      new Date().toISOString()
  });

  lessonJson.lessonId =
    permanentLesson.lessonId;

  persisted.record.lessonJson =
    lessonJson;

  await persistSessionMetadata({
    ...payload,
    lessonJson
  });
}

const jobResult =
  await JobService.ensureJobForSession({
    lessonId:
      lessonJson.lessonId,

      sessionId:
        persisted.record.sessionId,

      groupId:
        persisted.record.groupId || null,

      meetingTitle:
        lessonJson.meetingTitle || null,

      metadata: {
        groupFolderName:
          persisted.groupFolderName,

        sessionFolderName:
          persisted.sessionFolderName,

        meetingPlatform:
          lessonJson.meetingPlatform || null
      }
    });

  return {
    ...persisted,

    job: jobResult.job,
    jobCreated: jobResult.created
  };
}

 async function saveSessionMetadata(payload) {
  const persisted = await persistSessionMetadata(payload);

  if (!persisted.ok) {
    return persisted;
  }

  const groupDownload = await downloadJson(
    `${persisted.groupBase}/lesson_group.json`,
    persisted.groupRecord,
    "overwrite"
  );

  const lessonDownload = await downloadJson(
    `${persisted.sessionBase}/lesson.json`,
    persisted.record.lessonJson,
    "overwrite"
  );

  const statusDownload = await downloadJson(
    `${persisted.sessionBase}/status.json`,
    persisted.record.statusJson,
    "overwrite"
  );

  return {
    ok:
      groupDownload.ok &&
      lessonDownload.ok &&
      statusDownload.ok,

    groupFolderName:
      persisted.groupFolderName,

    sessionFolderName:
      persisted.sessionFolderName,

    pendingLessons:
      await getPendingCount(),

    downloads: {
      group: groupDownload,
      lesson: lessonDownload,
      status: statusDownload
    }
  };
}

async function markSessionNeedsAttention(sessionId, reason, errorDetail = null) {
  if (!sessionId) return { ok: false, reason: "NO_SESSION_ID" };
  const sessions = await getPendingSessions();
  const index = sessions.findIndex((s) => s.sessionId === sessionId);
  if (index < 0) return { ok: false, reason: "SESSION_NOT_FOUND" };

  const record = sessions[index];
  const now = new Date().toISOString();
  record.statusJson = {
    ...(record.statusJson || {}),
    state: "needs_attention",
    currentStep: reason || "Recording interrupted",
    lastUpdated: now,
    errors: [
      {
        reason: reason || "RECORDING_INTERRUPTED",
        error: errorDetail || null,
        timestamp: now,
        sessionId
      }
    ]
  };
  if (record.lessonJson) {
    record.lessonJson.stoppedAt = record.lessonJson.stoppedAt || now;
    record.lessonJson.stopReason = reason || "interrupted";
  }
  record.savedAt = now;
  sessions[index] = record;
  await setPendingSessions(sessions);

  const groupBase = `TeachAssist AI/Pending Uploads/${record.groupFolderName}`;
  const sessionBase = `${groupBase}/${record.sessionFolderName}`;
  await downloadJson(`${sessionBase}/status.json`, record.statusJson, "overwrite");
  if (record.lessonJson) await downloadJson(`${sessionBase}/lesson.json`, record.lessonJson, "overwrite");
  return { ok: true };
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "TA_PING" });
    return true;
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return true;
    } catch (error) {
      console.warn("TeachAssist could not inject content script:", error);
      return false;
    }
  }
}

async function sendToActiveMeetingTab(message) {
  const tab = await MeetingService.getActiveTab();
  if (!tab?.id || !MeetingService.isSupportedMeetingUrl(tab.url)) {
    await setIconForState("noMeeting");
    return { ok: false, reason: "NO_SUPPORTED_MEETING_TAB", platform: null };
  }

  await ensureContentScript(tab.id);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    return response || { ok: false, reason: "NO_RESPONSE", platform: MeetingService.getPlatformFromUrl(tab.url) };
  } catch (error) {
    return { ok: false, reason: "CONTENT_SCRIPT_NOT_READY", platform: MeetingService.getPlatformFromUrl(tab.url), error: String(error) };
  }
}

async function refreshIconFromActiveTab() {
  const global = await chrome.storage.local.get(["teachAssistGlobalState"]);
  if (global.teachAssistGlobalState?.isRecording) {
    await setIconForState("recording");
    return;
  }

  const response = await sendToActiveMeetingTab({ type: "TA_GET_STATE" });
  if (response?.ok && response.isMeeting) await setIconForState("active");
  else await setIconForState("noMeeting");
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await chrome.storage.local.get([
    "taPendingSessions",
    "taPendingGroups"
  ]);

  await chrome.storage.local.set({
      teachAssistGlobalState: {
        isRecording: false,
        activeSessionId: null,
        lastUpdated: new Date().toISOString()
      },
      taPendingSessions: Array.isArray(existing.taPendingSessions)
        ? existing.taPendingSessions
        : [],
      taPendingGroups: Array.isArray(existing.taPendingGroups)
        ? existing.taPendingGroups
        : []
    });
    
    if (details.reason === "install") {
      const { setupCompleted } =
        await chrome.storage.local.get("setupCompleted");
    
      if (!setupCompleted) {
        await chrome.tabs.create({
          url: chrome.runtime.getURL("setup.html")
        });
      }
    }

  await setIconForState("noMeeting");
});

chrome.tabs.onActivated.addListener(() => refreshIconFromActiveTab());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    // Diagnostic: this is exactly the event that would fire when
    // "End the call for everyone" navigates the Meet tab to its
    // post-call screen — logging it lets us line up the navigation
    // timestamp against the offscreen/content timeline.
    diagLog("tabs_onUpdated_fired", { tabId, status: changeInfo.status || null, url: changeInfo.url || null });
    refreshIconFromActiveTab();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  diagLog("tabs_onRemoved_fired", { tabId });
  // RecordingSessionService reads/writes the same "teachAssistGlobalState"
  // storage key this handler used to touch directly — activeTabId is
  // set together with activeSessionId in beginStarting(), so this check
  // already proves the closed tab belongs to the session currently
  // considered active; it is never "whatever happens to be active"
  // without that association. A closed tab that isn't the active
  // session's tab (e.g. an old, already-stopped session's tab) is a
  // no-op here.
  const currentState = await RecordingSessionService.getState();
  if (!currentState.isRecording || currentState.activeTabId !== tabId) {
    return;
  }

  const sessionId = currentState.activeSessionId;
  await setIconForState("noMeeting");

  // Route through the same canonical finalization path used by the
  // hotkey/popup and meeting-end termination methods — this is not a
  // second recording-finalization implementation, just a different
  // caller of stopRecorder(). content.js does not need to be alive for
  // this to succeed.
  const result = await stopRecorder({
    sessionId,
    stopReason: "tab_closed"
  });

  if (!result?.ok) {
    // Genuine, unrecoverable failure even after stopRecorder()'s own
    // ensureOffscreenDocument()+retry — fall back to needs_attention,
    // but now with the real reason/error preserved instead of the old
    // generic message with no detail.
    await markSessionNeedsAttention(
      sessionId,
      "Meeting tab closed before recording was stopped",
      result?.error || result?.reason || null
    );
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Let the offscreen document / a dedicated listener elsewhere in
  // this file handle these messages. If this listener's own
  // UNKNOWN_MESSAGE fallback responds first, the real response can be
  // lost — this is exactly what caused Delete Lesson and Retry
  // Transcription to sometimes report failure even though the real
  // operation succeeded (both have their own chrome.runtime.onMessage
  // listeners further down, but nothing stopped this listener from
  // also handling — and prematurely resolving — the same message).
  if (
    message?.type === "TA_OFFSCREEN_START_RECORDING" ||
    message?.type === "TA_OFFSCREEN_STOP_RECORDING" ||
    message?.type === "TA_RETRY_TRANSCRIPTION" ||
    message?.type === "TA_DELETE_LESSON" ||
    message?.type === "TA_MERGE_LESSONS" ||
    message?.type === "TA_START_AI_STAGE" ||
    message?.type === "TA_SAVE_AI_ARTIFACT_RESULT" ||
    message?.type === "TA_SAVE_SNAPSHOT_RESULT" ||
    message?.type === "TA_FAIL_AI_STAGE"
  ) {
    return false;
  }

  (async () => {
    if (message?.type === "TA_OFFSCREEN_STOP_COMPLETE") {
      // Pushed by offscreen.js once a Blob is actually finished
      // building — see performStop()/handleOffscreenStopComplete()
      // for why this is no longer carried as the direct response to
      // TA_OFFSCREEN_STOP_RECORDING.
      handleOffscreenStopComplete(message).catch((error) => {
        console.error("TeachAssist: handleOffscreenStopComplete failed:", error);
      });
      return;
    }

    if (message?.type === "TA_OFFSCREEN_TRACK_ENDED") {
      // Phase 2, Part C: fire-and-forget, same pattern as
      // TA_OFFSCREEN_STOP_COMPLETE above — offscreen.js does not wait
      // on a response.
      handleOffscreenTrackEnded(message).catch((error) => {
        console.error("TeachAssist: handleOffscreenTrackEnded failed:", error);
      });
      return;
    }

    if (message?.type === "TA_DIAG_LOG") {
      // Fire-and-forget entry from content.js or offscreen.js.
      if (message.entry) recordDiagEntry(message.entry).catch(() => {});
      return;
    }

    if (message?.type === "TA_DIAG_DUMP") {
      // Phase 2, Part E: lifecycle/verbose are the two split buffers;
      // `log` is kept as a chronologically-merged view of both, purely
      // for backward compatibility with any existing consumer that
      // expects a single flat array — no diagnostic information is
      // removed by the split, it's just organized into two buffers
      // instead of one.
      const data = await chrome.storage.local.get([DIAG_LOG_LIFECYCLE_KEY, DIAG_LOG_VERBOSE_KEY]);
      const lifecycle = Array.isArray(data[DIAG_LOG_LIFECYCLE_KEY]) ? data[DIAG_LOG_LIFECYCLE_KEY] : [];
      const verbose = Array.isArray(data[DIAG_LOG_VERBOSE_KEY]) ? data[DIAG_LOG_VERBOSE_KEY] : [];
      const log = [...lifecycle, ...verbose].sort((a, b) => (a.ts || 0) - (b.ts || 0));
      sendResponse({ ok: true, log, lifecycle, verbose });
      return;
    }

    if (message?.type === "TA_DIAG_CLEAR") {
      await chrome.storage.local.set({ [DIAG_LOG_LIFECYCLE_KEY]: [], [DIAG_LOG_VERBOSE_KEY]: [] });
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "TA_GET_ACTIVE_TAB_STATUS") {
      const tab = await MeetingService.getActiveTab();
      const platform = MeetingService.getPlatformFromUrl(tab?.url || "");
      const content = tab?.id && MeetingService.isSupportedMeetingUrl(tab.url) ? await sendToActiveMeetingTab({ type: "TA_GET_STATE" }) : null;
      const isMeeting = Boolean(content?.ok && content.isMeeting);
      await setIconForState(content?.isRecording ? "recording" : isMeeting ? "active" : "noMeeting");
      sendResponse({
        ok: true,
        isSupportedUrl: Boolean(tab?.url && MeetingService.isSupportedMeetingUrl(tab.url)),
        isMeeting,
        platform: isMeeting ? (content?.platform || platform) : null,
        url: tab?.url || "",
        tabId: tab?.id || null
      });
      return;
    }

    if (message?.type === "TA_POPUP_TOGGLE_RECORDING") {
      const response = await sendToActiveMeetingTab({ type: "TA_TOGGLE_RECORDING" });
      await refreshIconFromActiveTab();
      sendResponse(response);
      return;
    }

    if (message?.type === "TA_POPUP_GET_CONTENT_STATE") {
      const response = await sendToActiveMeetingTab({ type: "TA_GET_STATE" });
      sendResponse(response);
      return;
    }

    if (message?.type === "TA_GET_PENDING_COUNT") {
      sendResponse({ ok: true, pendingLessons: await getPendingCount() });
      return;
    }

    if (message?.type === "TA_GET_DASHBOARD_SNAPSHOT") {
      const lessons = await TeachAssistDB.listLessons();
    
      const lessonsWithPipeline = await Promise.all(
        lessons.map(async (lesson) => {
          const pipeline =
            await TeachAssistDB.getPipelineState(
              lesson.lessonId
            );
    
          return {
            lesson,
            pipeline
          };
        })
      );

  // TeachAssistDB only exposes listArtifacts(lessonId) and
  // getLogs(lessonId) — there is no cross-lesson listing, so the
  // snapshot gathers both by iterating over the real lessons above.
  const artifactsPerLesson = await Promise.all(
    lessons.map((lesson) =>
      TeachAssistDB.listArtifacts(lesson.lessonId)
    )
  );
  // chrome.runtime.sendMessage has a hard 64MiB limit on the entire
  // message — the exact historical failure mode this project has
  // already fixed once for the recording-stop path (see the blob-URL
  // architecture elsewhere in this file), now showing up here too as
  // lessons accumulate: an audio_prepared artifact's data can be tens
  // of MB of raw audio, and enough lessons in one snapshot response
  // adds up past the limit. The dashboard's own hasRecoverableAudio()
  // (mappers.ts) only ever checks audio_prepared.data != null — it
  // never reads the actual bytes through this response — so a small
  // truthy placeholder preserves that check exactly while removing
  // the payload that was overflowing the message. transcript/summary
  // artifacts are deliberately left untouched: their data IS read for
  // real content by the dashboard (mapArtifactToTranscript /
  // mapArtifactToSummary) and are orders of magnitude smaller anyway.
  // chrome.runtime.sendMessage has a hard 64MiB limit on the entire
  // message — the exact historical failure mode this project has
  // already fixed once for the recording-stop path (see the blob-URL
  // architecture elsewhere in this file). Stripping only audio_prepared's
  // data (the first fix here) was necessary but not sufficient: full
  // transcript content alone can run over 1MB per lesson, and with
  // enough accumulated lessons the aggregate across ALL of them in one
  // snapshot can still exceed the limit on its own. So this base
  // snapshot now strips ALL three heavy artifact types the same way —
  // audio_prepared, transcript, and summary — replacing each one's
  // data with a small truthy placeholder. hasRecoverableAudio()
  // (mappers.ts) only ever checks data != null for audio_prepared, so
  // that check is preserved exactly. The REAL transcript/summary
  // content is fetched separately, in safely-sized batches, via
  // TA_GET_ARTIFACTS_CONTENT_BATCH below — the dashboard merges it back
  // in before deriving lesson status, so every consumer (including
  // getLessonDisplayStatus's transcriptionComplete/summaryComplete)
  // ends up seeing the exact same real content it always did; only the
  // wire transfer is now chunked instead of being one giant message.
  const artifacts = artifactsPerLesson.flat().map((artifact) =>
    (artifact.artifactType === "audio_prepared" ||
      artifact.artifactType === "transcript" ||
      artifact.artifactType === "summary") &&
    artifact.data != null
      ? { ...artifact, data: true }
      : artifact
  );

  const logsPerLesson = await Promise.all(
    lessons.map((lesson) =>
      TeachAssistDB.getLogs(lesson.lessonId)
    )
  );
  const logs = logsPerLesson.flat();

  const jobs = await JobService.listJobs();

  const students = await TeachAssistDB.listStudentSnapshots();

  const recordingSession =
    await RecordingSessionService.getState();

  // lessonJson.durationSeconds (a real, timestamp-based value set by
  // content.js when recording stops) lives in chrome.storage's
  // taPendingSessions, not in TeachAssistDB. It is included here so
  // the dashboard can use it instead of the DB's
  // recorderMeasuredDurationMs field.
  const pendingSessions = await getPendingSessions();

  sendResponse({
    ok: true,
    generatedAt:
      new Date().toISOString(),
    lessons:
      lessonsWithPipeline,
    recordingSession,
    artifacts,
    jobs,
    students,
    logs,
    pendingSessions
  });

  return;
}

// Fetches the REAL content (transcript/summary artifact .data) for a
// batch of lessons at once — always safely under the 64MiB message
// limit as long as the caller keeps batches reasonably sized (the
// dashboard chunks by lesson count; see ExtensionDataAdapter.refresh()).
// Never fetches audio_prepared content — the dashboard has no use for
// the raw audio bytes themselves, only whether the artifact exists
// (already covered by the base snapshot's placeholder).
if (message?.type === "TA_GET_ARTIFACTS_CONTENT_BATCH") {
  const lessonIds = Array.isArray(message.lessonIds) ? message.lessonIds : [];

  const artifactsPerLesson = await Promise.all(
    lessonIds.map((lessonId) => TeachAssistDB.listArtifacts(lessonId))
  );

  const artifacts = artifactsPerLesson
    .flat()
    .filter((artifact) => artifact.artifactType === "transcript" || artifact.artifactType === "summary");

  sendResponse({ ok: true, artifacts });
  return;
}

if (message?.type === "TA_UPDATE_LESSON_STUDENT_NAME") {
  const lessonId = message.lessonId;
  const studentName =
        typeof message.studentName === "string"
          ? message.studentName.trim()
          : "";

      if (!lessonId || !studentName) {
        sendResponse({
          ok: false,
          error: "A lessonId and a non-empty studentName are required."
        });
        return;
      }

      // updateLessonInformation only touches updates.student when
      // studentName/studentId are passed — class.title (meetingTitle)
      // is left untouched here.
      const updatedLesson =
        await LessonService.updateLessonInformation(lessonId, {
          studentName
        });

      sendResponse({
        ok: true,
        lesson: updatedLesson
      });

      return;
    }
      
    if (message?.type === "TA_SAVE_RECORDING_DATA") {
      const payload = message.payload || {};
      const safeGroup = safeSegment(payload.groupFolderName || "lesson_group");
      const safeSession = safeSegment(payload.sessionFolderName || "session_001");
      const recordingFilename = safeSegment(
  payload.filename || "lesson.webm");
    const filename = `TeachAssist AI/Pending Uploads/${safeGroup}/${safeSession}/${recordingFilename}`;
      const download = await downloadRecording(filename, payload.dataUrl);
      sendResponse({
        ok: Boolean(download?.ok),
        filename,
        sizeBytes: payload.sizeBytes || null,
        mimeType: payload.mimeType || "audio/webm",
        download
      });
      return;
    }

    if (message?.type === "TA_START_REAL_RECORDING") {
      const response = await startRecorder(sender?.tab?.id, message.payload || {});
      sendResponse(response);
      return;
    }
    
    if (message?.type === "TA_STOP_REAL_RECORDING") {
      const result = await stopRecorder(message.payload || {});
      sendResponse(result);
      return;
    }

    if (message?.type === "TA_REGISTER_SESSION_METADATA") {
      const response = await registerSessionMetadata(message.payload || {});
      sendResponse(response);
      return;
    }

    if (message?.type === "TA_SAVE_SESSION_METADATA") {
      const response = await saveSessionMetadata(message.payload || {});
      sendResponse(response);
      return;
    }

    if (message?.type === "TA_MEETING_STATE_CHANGED") {
      const global = await chrome.storage.local.get(["teachAssistGlobalState"]);
      const globalRecording = Boolean(global.teachAssistGlobalState?.isRecording);
      if (globalRecording || message.isRecording) {
        await setIconForState("recording");
      } else if (message.isMeeting) {
        await setIconForState("active");
      } else {
        await setIconForState("noMeeting");
      }
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "TA_RECORDING_STATE_CHANGED") {
  const isRecording =
    Boolean(message.isRecording);

  const tabId =
    sender?.tab?.id || null;

  try {
    if (isRecording) {
      const currentState =
        await RecordingSessionService.getState();

      /*
       * The content script may report that recording
       * began before the session service has registered
       * the session. Register it here when necessary.
       */
      if (!currentState.activeSessionId) {
        if (!message.sessionId) {
          throw new Error(
            "Recording started without a sessionId."
          );
        }

        if (!Number.isInteger(tabId)) {
          throw new Error(
            "Recording started without a valid tabId."
          );
        }

        await RecordingSessionService.beginStarting({
          sessionId: message.sessionId,
          tabId,
          meeting: null
        });
      }

      await RecordingSessionService.markRecording();
    } else {
      const currentState =
        await RecordingSessionService.getState();

      const isStillTheActiveSession =
        !message.sessionId ||
        currentState.activeSessionId === message.sessionId;

      if (currentState.activeSessionId && isStillTheActiveSession) {
        await RecordingSessionService.beginStopping({
          reason: "recording_stopped"
        });

        await RecordingSessionService.markStopped({
          reason: "recording_stopped"
        });

        /*
         * Preserve the previous behavior: once recording stops,
         * clear the live session — but only when this message is
         * genuinely about the session that's still considered
         * active. A different, newer session (already started while
         * this one was still finalizing) must never be cleared by an
         * older session's stop report.
         */
        await RecordingSessionService.reset();
      }
    }

    await setIconForState(
      isRecording
        ? "recording"
        : message.isMeeting
          ? "active"
          : "noMeeting"
    );

    sendResponse({
      ok: true,
      state:
        await RecordingSessionService.getState()
    });
  } catch (error) {
    await RecordingSessionService.markError(
      error
    );

    console.error(
      "TeachAssist recording state update failed:",
      error
    );

    sendResponse({
      ok: false,
      reason:
        "RECORDING_STATE_UPDATE_FAILED",
      error:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }

  return;
}

        sendResponse({
      ok: false,
      reason: "UNKNOWN_MESSAGE"
    });
  })().catch((error) => {
    console.error(
      "TeachAssist background message handler failed:",
      error
    );

    try {
      sendResponse({
        ok: false,
        reason: "BACKGROUND_HANDLER_FAILED",
        error:
          error instanceof Error
            ? error.message
            : String(error)
      });
    } catch (responseError) {
      console.error(
        "TeachAssist could not send error response:",
        responseError
      );
    }
  });

  return true;
});

/*
 * ============================================================
 * TeachAssist AI — Transcription (MVP)
 *
 * recording complete -> Deepgram (stereo, multichannel) ->
 * transcript artifact -> Ready / Needs Attention -> toast.
 *
 * Speaker identity comes only from the recording channel — never
 * from Deepgram's speaker/diarization order. This mirrors the
 * verified fix already applied to the reference recorder
 * (class-recorder-v0.5.7): channel 0 = microphone, channel 1 =
 * tab audio.
 * ============================================================
 */

function dataUrlToBlob(dataUrl) {
  const [header, base64] = String(dataUrl || "").split(",");
  const mimeMatch = /data:([^;]+);base64/.exec(header || "");
  const mimeType = mimeMatch ? mimeMatch[1] : "audio/webm";

  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

const TA_PORTUGUESE_KEYTERMS = [
  "não", "então", "também", "porque", "você", "vocês", "gente", "a gente",
  "português", "Brasil", "brasileiro", "brasileira"
];

function taNormalizeUtteranceText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[.,!?;:"'“”‘’()\-–—…]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Conservative token-overlap similarity (Jaccard on word sets).
function taTextSimilarity(a, b) {
  const normA = taNormalizeUtteranceText(a);
  const normB = taNormalizeUtteranceText(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  const tokensA = new Set(normA.split(" "));
  const tokensB = new Set(normB.split(" "));
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;

  return union === 0 ? 0 : intersection / union;
}

function taUtterancesOverlapOrNear(a, b, toleranceMs = 1200) {
  const overlaps = a.start <= b.end && b.start <= a.end;
  if (overlaps) return true;

  const gap = a.start >= b.end ? a.start - b.end : b.start - a.end;
  return gap <= toleranceMs;
}

const TA_TAB_ECHO_TEXT_SIMILARITY_THRESHOLD = 0.75;

// Removes Channel 1 (tab) utterances that are almost certainly the
// teacher's own microphone audio echoed back through the meeting tab.
// Both a timing match AND a strong text match are required, so
// legitimate short student replies are never discarded on timing alone.
function taRemoveTabEcho(teacherUtterances, studentUtterances) {
  let echoCount = 0;

  const keptStudentUtterances = studentUtterances.filter((studentUtterance) => {
    const isEcho = teacherUtterances.some((teacherUtterance) => {
      if (!taUtterancesOverlapOrNear(teacherUtterance, studentUtterance)) return false;
      return taTextSimilarity(teacherUtterance.text, studentUtterance.text) >= TA_TAB_ECHO_TEXT_SIMILARITY_THRESHOLD;
    });

    if (isEcho) echoCount += 1;
    return !isEcho;
  });

  return { keptStudentUtterances, echoCount };
}

/*
 * One stereo file, one Deepgram request, multichannel=true. Channel 0
 * (mic) is always "Teacher"; channel 1 (tab) is always the real
 * student name from the lesson record. Never uses Deepgram's
 * speaker/diarization order.
 */
async function transcribeLessonAudioWithDeepgram({ blob, apiKey, teacherLabel, studentLabel }) {
  if (!apiKey) throw new Error("No Deepgram API key saved.");
  if (!blob || blob.size === 0) throw new Error("The lesson recording is empty.");

  const query = new URLSearchParams({
    model: "nova-3",
    language: "multi",
    smart_format: "true",
    punctuate: "true",
    utterances: "true",
    multichannel: "true"
  });
  TA_PORTUGUESE_KEYTERMS.forEach((term) => query.append("keyterm", term));

  const response = await fetch(`https://api.deepgram.com/v1/listen?${query}`, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": blob.type || "audio/webm" },
    body: blob
  });

  const responseText = await response.text();
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; } catch (_) {}

  if (!response.ok) {
    throw new Error(`Deepgram transcription failed (${response.status}): ${data?.err_msg || data?.error || data?.message || responseText || "Unknown error"}`);
  }

  const rawUtterances = Array.isArray(data?.results?.utterances) ? data.results.utterances : [];

  const normalized = rawUtterances
    .map((u) => ({
      channel: Number.isFinite(Number(u.channel)) ? Number(u.channel) : 0,
      start: Math.round(Number(u.start || 0) * 1000),
      end: Math.round(Number(u.end || 0) * 1000),
      text: String(u.transcript || u.text || "").trim()
    }))
    .filter((u) => u.text);

  const teacherUtterances = normalized.filter((u) => u.channel === 0);
  const studentUtterancesRaw = normalized.filter((u) => u.channel !== 0);

  const { keptStudentUtterances, echoCount } = taRemoveTabEcho(teacherUtterances, studentUtterancesRaw);

  const utterances = [
    ...teacherUtterances.map((u) => ({ speaker: teacherLabel, source: "microphone", channel: 0, start: u.start, end: u.end, text: u.text })),
    ...keptStudentUtterances.map((u) => ({ speaker: studentLabel, source: "tabAudio", channel: 1, start: u.start, end: u.end, text: u.text }))
  ].sort((a, b) => a.start - b.start);

  if (!utterances.length) {
    throw new Error("No transcript text returned from the lesson recording.");
  }

  return {
    utterances,
    tabEchoRemovedCount: echoCount,
    audioDuration: Number(data?.metadata?.duration || 0) || null,
    languageCode: data?.results?.channels?.[0]?.alternatives?.[0]?.detected_language || "multi",
    raw: data
  };
}

/*
 * Orchestrates: Prepared Audio artifact -> recording-stage completion
 * -> Deepgram transcription -> Transcript artifact -> Ready / Needs
 * Attention. Called after a successful recording stop; never throws
 * back to the caller — all failures are recorded on the lesson so the
 * dashboard can show Needs Attention instead of the recording getting
 * silently stuck on Processing.
 */
async function finalizeAndTranscribeRecording({ sessionId, stoppedAt }) {
  const stopKeepAlive = startServiceWorkerKeepAlive();
  let lessonId = null;

  try {
    if (!sessionId) return;

    const pendingSessions = await getPendingSessions();
    const session = pendingSessions.find((item) => item.sessionId === sessionId);
    lessonId = session?.lessonJson?.lessonId || null;

    if (!lessonId) {
      console.warn("TeachAssist could not resolve a lessonId for transcription; session:", sessionId);
      return;
    }

    // The artifact was already saved directly to IndexedDB by
    // offscreen.js's finalizeStop() — the same Blob that became
    // lesson.webm, written once, in the document that built it. This
    // reads it back rather than re-deriving it, so there is exactly
    // one finalization of the audio, not two independent ones.
    const artifact = await ArtifactService.getArtifact(lessonId, "audio_prepared");

    if (!artifact?.data) {
      console.warn("TeachAssist: no prepared-audio artifact found for lessonId:", lessonId);
      await TeachAssistDB.updatePipelineStage(lessonId, "recording", {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: { code: "PREPARED_AUDIO_ARTIFACT_MISSING", message: "offscreen.js did not report a saved artifact for this session." }
      }).catch(() => {});
      return;
    }

    const audioBlob = artifact.data;
    const expectStereo = Boolean(artifact.metadata?.expectStereo);
    const stereoValidation = artifact.metadata?.stereoValidation || null;
    const recordingHasStereoWarning = expectStereo && stereoValidation && !stereoValidation.ok;

    await TeachAssistDB.updateLesson(lessonId, {
      recording: {
        status: recordingHasStereoWarning ? "completed_with_warning" : "completed",
        stoppedAt: stoppedAt || new Date().toISOString()
      },
      overallStatus: "pending"
    });

    await TeachAssistDB.updatePipelineStage(lessonId, "recording", {
      status: "completed",
      finishedAt: new Date().toISOString(),
      error: null
    });

    await LoggingService.info({
      lessonId,
      stage: "recording",
      code: "RECORDING_COMPLETED",
      message: recordingHasStereoWarning
        ? "The lesson recording was saved, but stereo channel separation could not be verified."
        : "The lesson recording was saved as verified stereo audio.",
      metadata: { expectStereo, stereoValidation }
    });

    await transcribeAndStoreLesson({ lessonId, sessionId, audioBlob });
  } catch (error) {
    console.error("TeachAssist recording finalization failed:", error);

    if (lessonId) {
      await TeachAssistDB.updatePipelineStage(lessonId, "recording", {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: { code: "RECORDING_FINALIZE_FAILED", message: String(error?.message || error) }
      }).catch(() => {});

      await LoggingService.recordError({
        lessonId,
        stage: "recording",
        category: "recording",
        code: "RECORDING_FINALIZE_FAILED",
        userMessage: "The lesson recording could not be fully saved.",
        technicalMessage: String(error?.message || error),
        recoverable: false,
        suggestedAction: "inspect_recording"
      }).catch(() => {});
    }
  } finally {
    stopKeepAlive();
  }
}

/*
 * The single reusable transcription step. Both the initial recording
 * flow and TA_RETRY_TRANSCRIPTION call this same function, so retries
 * can never use different speaker-mapping logic than the first attempt.
 */

// MV3 service workers can be suspended by Chrome as idle after as
// little as ~30 seconds. finalizeAndTranscribeRecording() runs as a
// fire-and-forget promise (deliberately, so stopping the recorder
// doesn't block on transcription) — but that also means Chrome has no
// signal that real work (job creation, the Deepgram request, artifact
// saves) is still happening, and can kill the worker mid-task with no
// error at all. This is the actual cause of jobs being observed stuck
// at PENDING indefinitely. A trivial, harmless chrome.storage call on
// a short interval resets the idle timer for as long as real
// transcription work is in flight.
function startServiceWorkerKeepAlive() {
  const intervalId = setInterval(() => {
    chrome.storage.local.get("__ta_keepalive__", () => {
      void chrome.runtime.lastError;
    });
  }, 20000);

  return () => clearInterval(intervalId);
}

async function transcribeAndStoreLesson({ lessonId, sessionId, audioBlob }) {
  const stopKeepAlive = startServiceWorkerKeepAlive();

  // jobId is tracked outside the try block so the catch below can
  // fail the job even if the exception happened after it was
  // created. This function guarantees the transcription pipeline
  // stage always ends in "completed" or "failed" — never left
  // hanging at "running"/"waiting" — no matter which step below
  // throws. That guarantee is what stops a lesson from ever getting
  // stuck indefinitely on Processing.
  let jobId = null;
  let lesson = null;

  try {
    lesson = await TeachAssistDB.getLesson(lessonId);
    const studentLabel = lesson?.student?.name || "Student";
    const teacherLabel = "Teacher";

    const jobResult = await JobService.ensureJobForSession({
      lessonId,
      sessionId: sessionId || lessonId,
      meetingTitle: lesson?.class?.title || null
    });
    jobId = jobResult.job.jobId;

    await JobService.startJob(jobId, JobService.JOB_STEP.TRANSCRIPTION);

    await TeachAssistDB.updatePipelineStage(lessonId, "transcription", {
      status: "running",
      startedAt: new Date().toISOString(),
      error: null
    });

    const settings = await chrome.storage.local.get({
      transcriptionProvider: "deepgram",
      deepgramApiKey: ""
    });

    if (settings.transcriptionProvider !== "deepgram" || !settings.deepgramApiKey) {
      const message = !settings.deepgramApiKey
        ? "The Deepgram API key is missing. Add it in TeachAssist settings, then retry transcription."
        : `Unsupported transcription provider: ${settings.transcriptionProvider}`;

      const keyError = new Error(message);
      keyError.code = "DEEPGRAM_API_KEY_MISSING";
      keyError.suggestedAction = "add_deepgram_api_key";
      throw keyError;
    }

    const transcript = await transcribeLessonAudioWithDeepgram({
      blob: audioBlob,
      apiKey: settings.deepgramApiKey,
      teacherLabel,
      studentLabel
    });

    await ArtifactService.saveTranscript({
      lessonId,
      contentKind: ArtifactService.CONTENT_KINDS.JSON,
      mimeType: "application/json",
      filename: "transcript.json",
      data: {
        utterances: transcript.utterances,
        teacherLabel,
        studentLabel,
        tabEchoRemovedCount: transcript.tabEchoRemovedCount,
        audioDuration: transcript.audioDuration,
        languageCode: transcript.languageCode,
        multichannel: true,
        provider: "deepgram",
        rawResponse: transcript.raw
      },
      metadata: {
        provider: "deepgram",
        multichannel: true,
        tabEchoRemovedCount: transcript.tabEchoRemovedCount
      }
    });

    // Verify the transcript artifact is actually retrievable before
    // touching the audio at all. Audio is never deleted based merely
    // on "Deepgram returned something" or "the save call didn't
    // throw" — only after a real, re-read confirmation.
    const savedTranscript = await ArtifactService.getArtifact(
      lessonId,
      ArtifactService.ARTIFACT_TYPES.TRANSCRIPT
    );

    if (!savedTranscript || !savedTranscript.data) {
      throw new Error("The transcript was generated, but could not be verified in storage afterward.");
    }

    await TeachAssistDB.updatePipelineStage(lessonId, "transcription", {
      status: "completed",
      finishedAt: new Date().toISOString(),
      error: null
    });

    await JobService.addArtifact(jobId, "transcript", {
      artifactType: "transcript",
      utteranceCount: transcript.utterances.length
    });
    await JobService.completeJob(jobId);

    await LoggingService.info({
      lessonId,
      stage: "transcription",
      code: "TRANSCRIPTION_COMPLETED",
      message: "Deepgram transcription completed and the transcript was saved.",
      metadata: {
        utteranceCount: transcript.utterances.length,
        tabEchoRemovedCount: transcript.tabEchoRemovedCount
      }
    });

    await applyRecordingRetentionPolicy({ lessonId, studentLabel, audioBlob });

    // MIGRATION: the recorder's AI-related responsibility ends here.
    // Lesson AI Summary generation, Regenerate, and Share with Student
    // are now entirely owned by the dashboard
    // (dashboard/src/ai/aiSummaryService.ts), which discovers this
    // transcript on its own next refresh (transcript exists, summary
    // missing -> eligible for generation) — it does not depend on
    // this broadcast to work, including when the dashboard was closed
    // when transcription finished. This is a best-effort, non-blocking
    // signal only.
    try {
      await chrome.runtime.sendMessage({
        type: "TA_TRANSCRIPT_READY",
        lessonId,
        studentName: lesson?.student?.name || null
      });
    } catch (_) {
      // No listener is fine — see above.
    }
  } catch (error) {
    const message = String(error?.message || error);
    const code = error?.code || "DEEPGRAM_TRANSCRIPTION_FAILED";

    // Best-effort, but every one of these is independently guarded so
    // one failing (e.g. a logging error) can never prevent the pipeline
    // stage itself from being marked failed.
    await TeachAssistDB.updatePipelineStage(lessonId, "transcription", {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: { code, message }
    }).catch((updateError) => {
      console.error("TeachAssist could not mark transcription failed:", updateError);
    });

    if (jobId) {
      await JobService.failJob(jobId, message, JobService.JOB_STEP.TRANSCRIPTION).catch(() => {});
    }

    await LoggingService.recordError({
      lessonId,
      stage: "transcription",
      category: "transcription",
      code,
      userMessage:
        code === "DEEPGRAM_API_KEY_MISSING"
          ? message
          : "Transcription failed. The recording is safe and can be retried.",
      technicalMessage: message,
      recoverable: true,
      suggestedAction: error?.suggestedAction || "retry_transcription"
    }).catch(() => {});
  } finally {
    stopKeepAlive();
  }
}


// Applies the tutor's recording-retention setting. Only ever called
// after the transcript artifact has been saved AND verified — never
// on transcription start, and never on an unverified success.
async function applyRecordingRetentionPolicy({ lessonId, studentLabel, audioBlob }) {
  const settings = await chrome.storage.local.get({
    recordingRetention: "delete"
  });

  try {
    if (settings.recordingRetention === "keep_copy") {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const dataUrl = dataUrlForBlobArrayBuffer(arrayBuffer, audioBlob.type || "audio/webm");
      const safeStudent = safeSegment(studentLabel || "lesson");
      const filename = `TeachAssist AI/Recordings/${safeStudent}_${lessonId}.webm`;

      const download = await downloadRecording(filename, dataUrl);

      if (!download.ok) {
        // Keep the temporary audio if the permanent copy couldn't be
        // saved — never delete the only remaining copy on a failed
        // download.
        await LoggingService.warning({
          lessonId,
          stage: "recording",
          code: "RECORDING_COPY_FAILED",
          message: "Could not save a permanent copy of the recording to Downloads. The temporary recording was kept.",
          metadata: { filename, error: download.error || null }
        });
        return;
      }

      await LoggingService.info({
        lessonId,
        stage: "recording",
        code: "RECORDING_COPY_SAVED",
        message: "A permanent copy of the recording was saved to Downloads.",
        metadata: { filename }
      });
    }

    // TeachAssist's own temporary copy is removed either way once a
    // verified transcript exists — the tutor's Downloads copy (if
    // any) lives outside TeachAssist's managed storage and is
    // unaffected.
    await ArtifactService.markArtifactDeleted(
      lessonId,
      ArtifactService.ARTIFACT_TYPES.AUDIO_PREPARED,
      { reason: "transcription_succeeded_auto_cleanup" }
    );
  } catch (error) {
    // Cleanup failing is not itself a transcription failure — the
    // lesson still has a valid, verified transcript and should stay
    // Ready. Just log it so it's visible for diagnostics.
    await LoggingService.warning({
      lessonId,
      stage: "recording",
      code: "RECORDING_RETENTION_CLEANUP_FAILED",
      message: "The temporary recording could not be cleaned up automatically.",
      metadata: { error: String(error?.message || error) }
    }).catch(() => {});
  }
}

// Manual retry entry point. Reuses the Prepared Audio artifact already
// saved on the lesson (no re-recording needed) and calls the exact
// same transcribeAndStoreLesson() used on the first attempt. Fire-
// and-forget past validation, so the dashboard can show Processing
// right away instead of only after the full Deepgram round-trip.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TA_RETRY_TRANSCRIPTION") return false;

  (async () => {
    try {
      const lessonId = message.lessonId;
      if (!lessonId) {
        sendResponse({ ok: false, error: "A lessonId is required." });
        return;
      }

      const artifact = await ArtifactService.getArtifact(lessonId, ArtifactService.ARTIFACT_TYPES.AUDIO_PREPARED);
      if (!artifact || !artifact.data) {
        sendResponse({ ok: false, error: "No saved recording is available to retry." });
        return;
      }

      sendResponse({ ok: true });

      transcribeAndStoreLesson({ lessonId, sessionId: lessonId, audioBlob: artifact.data }).catch((error) => {
        console.error("TeachAssist retry transcription failed:", error);
      });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();

  return true;
});


// Permanently deletes a lesson and everything TeachAssist itself
// manages for it. TeachAssistDB.deleteLesson() already removes the
// lesson record, pipeline state, all artifacts, and all logs in one
// transaction; jobs are stored separately (chrome.storage, not
// IndexedDB) so they're cleaned up here too. A Downloads copy the
// tutor chose to keep is outside TeachAssist's managed storage and is
// never touched by this.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TA_DELETE_LESSON") return false;

  (async () => {
    try {
      const lessonId = message.lessonId;
      if (!lessonId) {
        sendResponse({ ok: false, error: "A lessonId is required." });
        return;
      }

      await TeachAssistDB.deleteLesson(lessonId);

      const allJobs = await JobService.listJobs();
      const lessonJobs = allJobs.filter((job) => job.lessonId === lessonId);
      for (const job of lessonJobs) {
        await JobService.deleteJob(job.jobId);
      }

      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();

  return true;
});

// Phase 2, Part F/L: logical lesson merge. All the atomic write work
// (parent creation, mergedInto marking, transaction safety) lives in
// TeachAssistDB.mergeLessons() — this handler is purely message
// plumbing, modeled directly on TA_DELETE_LESSON above.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TA_MERGE_LESSONS") return false;

  (async () => {
    try {
      const sourceLessonIds = Array.isArray(message.sourceLessonIds) ? message.sourceLessonIds : null;
      if (!sourceLessonIds || sourceLessonIds.length < 2) {
        sendResponse({ ok: false, error: "At least two sourceLessonIds are required." });
        return;
      }

      diagLog("merge_lessons_requested", { sourceLessonIds });

      const result = await TeachAssistDB.mergeLessons({
        sourceLessonIds,
        studentId: message.studentId || null,
        studentName: message.studentName || null,
        classTitle: message.classTitle || null
      });

      diagLog("merge_lessons_completed", {
        parentLessonId: result.parentLesson.lessonId,
        sourceLessonIds: result.sourceLessonIds
      });

      sendResponse({
        ok: true,
        parentLessonId: result.parentLesson.lessonId,
        sourceLessonIds: result.sourceLessonIds
      });
    } catch (error) {
      diagLog("merge_lessons_failed", { error: String(error?.message || error) });
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();

  return true;
});

/*
 * ============================================================
 * Dashboard AI Layer support.
 *
 * The recorder's only AI-related responsibility is Deepgram
 * speech-to-text transcription. Lesson Summary generation, Regenerate,
 * Share with Student, and all future LLM/AI processing are owned
 * entirely by the dashboard (dashboard/src/ai/aiSummaryService.ts).
 *
 * These three handlers are the recorder's entire remaining surface
 * for that AI work: a narrow, generic API to persist pipeline/job/
 * artifact state the dashboard decides. The recorder never calls an
 * AI provider, never constructs a prompt, and never decides what to
 * generate — it only records the result it's told.
 * ============================================================
 */

// Starts (or resumes) an AI processing stage for a lesson: advances
// the lesson's single job to the given step and marks the matching
// pipeline stage "running". Returns the jobId so the caller can pass
// it back to TA_SAVE_AI_ARTIFACT_RESULT / TA_FAIL_AI_STAGE.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TA_START_AI_STAGE") return false;

  (async () => {
    try {
      const { lessonId, stage } = message;
      if (!lessonId || !stage) {
        sendResponse({ ok: false, error: "A lessonId and stage are required." });
        return;
      }

      const jobResult = await JobService.ensureJobForSession({
        lessonId,
        sessionId: lessonId,
        meetingTitle: null
      });
      const jobId = jobResult.job.jobId;

      await JobService.updateStep(jobId, stage);

      await TeachAssistDB.updatePipelineStage(lessonId, stage, {
        status: "running",
        startedAt: new Date().toISOString(),
        error: null
      });

      sendResponse({ ok: true, jobId });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();

  return true;
});

// Saves the result of a completed AI stage: writes the artifact via
// the existing generic ArtifactService.createArtifact() (the same
// lessonId+artifactType composite key already used everywhere else,
// so this naturally replaces/updates rather than duplicating), then
// verifies it, marks the pipeline stage completed, and completes the
// job. Reused unchanged for any future AI artifact type.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TA_SAVE_AI_ARTIFACT_RESULT") return false;

  (async () => {
    try {
      const { lessonId, jobId, stage, artifactType, data, metadata, filename, mimeType } = message;
      if (!lessonId || !jobId || !stage || !artifactType) {
        sendResponse({ ok: false, error: "lessonId, jobId, stage, and artifactType are required." });
        return;
      }

      await ArtifactService.createArtifact({
        lessonId,
        type: artifactType,
        data,
        contentKind: ArtifactService.CONTENT_KINDS.JSON,
        mimeType: mimeType || "application/json",
        filename: filename || `${artifactType}.json`,
        // ArtifactService.createArtifact() requires a non-empty
        // displayName (validateCreateInput -> requireNonEmptyString).
        // The dashboard AI layer does not currently send one in
        // metadata (today it only sends {provider, model}), so prefer
        // it if a future caller supplies one, otherwise fall back to
        // a readable label derived from artifactType — always
        // non-empty, since artifactType is already required truthy
        // by the check above.
        displayName:
          metadata?.displayName ||
          `${artifactType.charAt(0).toUpperCase()}${artifactType.slice(1)} (AI Generated)`,
        metadata: metadata || {}
      });

      const saved = await ArtifactService.getArtifact(lessonId, artifactType);
      if (!saved || !saved.data) {
        throw new Error(`The ${artifactType} artifact was saved, but could not be verified in storage afterward.`);
      }

      await TeachAssistDB.updatePipelineStage(lessonId, stage, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        error: null
      });

      await JobService.addArtifact(jobId, artifactType, { artifactType });
      await JobService.completeJob(jobId);

      await LoggingService.info({
        lessonId,
        stage,
        code: `${stage.toUpperCase()}_COMPLETED`,
        message: `Dashboard AI layer completed the "${stage}" stage and saved a "${artifactType}" artifact.`,
        metadata: { artifactType }
      });

      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();

  return true;
});

// Saves a completed Teaching Snapshot update. Unlike
// TA_SAVE_AI_ARTIFACT_RESULT, this does not go through
// ArtifactService — a Teaching Snapshot is per-student long-term
// state, not a per-lesson artifact, so it's written to the students
// store via TeachAssistDB.saveStudentSnapshot() (the same deepMerge()
// safety updateLesson() uses, so this can never wipe unrelated
// student fields). Only ever called on genuine success — a failed or
// partial snapshot goes through TA_FAIL_AI_STAGE instead, which never
// touches this store, leaving whatever was previously saved
// completely untouched.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TA_SAVE_SNAPSHOT_RESULT") return false;

  (async () => {
    try {
      const { lessonId, jobId, stage, studentId, snapshot } = message;
      if (!lessonId || !jobId || !stage || !studentId || !snapshot) {
        sendResponse({ ok: false, error: "lessonId, jobId, stage, studentId, and snapshot are required." });
        return;
      }

      await TeachAssistDB.saveStudentSnapshot(studentId, {
        snapshot,
        sourceLessonId: lessonId
      });

      const saved = await TeachAssistDB.getStudentSnapshot(studentId);
      if (!saved || !saved.snapshot) {
        throw new Error("The Teaching Snapshot was saved, but could not be verified in storage afterward.");
      }

      await TeachAssistDB.updatePipelineStage(lessonId, stage, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        error: null
      });

      await JobService.completeJob(jobId);

      await LoggingService.info({
        lessonId,
        stage,
        code: "TEACHING_SNAPSHOT_UPDATED",
        message: "Teaching Snapshot updated for this student.",
        metadata: { studentId }
      });

      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();

  return true;
});

// Records a failed AI stage: marks the pipeline stage failed with the
// real error, fails the job, and logs it — never silently leaves a
// lesson stuck. The transcript (and any other already-saved
// artifacts) are completely untouched by this.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TA_FAIL_AI_STAGE") return false;

  (async () => {
    try {
      const { lessonId, jobId, stage, code, message: errorMessage } = message;
      if (!lessonId || !stage) {
        sendResponse({ ok: false, error: "A lessonId and stage are required." });
        return;
      }

      const finalMessage = errorMessage || "AI processing failed.";
      const finalCode = code || "DASHBOARD_AI_STAGE_FAILED";

      await TeachAssistDB.updatePipelineStage(lessonId, stage, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: { code: finalCode, message: finalMessage }
      }).catch((updateError) => {
        console.error(`TeachAssist could not mark "${stage}" failed:`, updateError);
      });

      if (jobId) {
        await JobService.failJob(jobId, finalMessage, stage).catch(() => {});
      }

      await LoggingService.recordError({
        lessonId,
        stage,
        category: stage,
        code: finalCode,
        userMessage: finalMessage,
        technicalMessage: finalMessage,
        recoverable: true,
        suggestedAction: `retry_${stage}`
      }).catch(() => {});

      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();

  return true;
});