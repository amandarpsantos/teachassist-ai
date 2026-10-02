/*
 * ============================================================
 * TeachAssist AI — Offscreen Recorder
 *
 * SESSION ISOLATION (see the recording-reliability migration notes):
 *
 * Each recording session is a fully self-contained object —
 * mediaRecorder, recordedChunks, streams, audioContext all live on
 * that one object. Nothing about a session's own state is ever
 * touched by a different session.
 *
 * The only module-level mutable state is `activeSession`: a pointer
 * to whichever session object currently owns the live, recording
 * MediaRecorder — or null if none does. stopRecording() detaches this
 * pointer (sets it to null) immediately, before doing any of the
 * asynchronous finalization work (awaiting onstop, building the blob,
 * validating stereo, tearing down streams). That detach is what lets
 * a new startRecording() begin right away without waiting for, or
 * being able to corrupt, the previous session's still-in-progress
 * finalization — startRecording() only ever refuses when
 * activeSession is genuinely still the live recorder.
 * ============================================================
 */

let activeSession = null;

// ---- Diagnostic-only instrumentation (temporary) ----
// Added to root-cause the "End call for everyone" recording-loss
// bug (NOT_RECORDING at stop time after a long, apparently-healthy
// recording). Every call here is fire-and-forget, wrapped so it can
// never throw into or delay the caller, and changes nothing about
// recording/start/stop behavior. Safe to remove once the root cause
// is confirmed.
//
// OFFSCREEN_INSTANCE_ID is generated fresh every time this script
// runs — i.e. every time the offscreen document loads. If the
// document is destroyed and Chrome recreates it mid-recording, a
// second "offscreen_document_loaded" event with a *different*
// instance id is the direct, unambiguous signal that happened.
const OFFSCREEN_INSTANCE_ID = crypto.randomUUID();

// Tracks stop finalization per sessionId. This is what makes a
// duplicate or late TA_OFFSCREEN_STOP_RECORDING for the same session
// safe: it never starts a second stop, and a completed result is
// always the authoritative answer for every caller, no matter how
// many times they ask. finalizationPromises holds in-flight work;
// finalizedResults holds the settled outcome once known.
const finalizationPromises = new Map();
const finalizedResults = new Map();
// Tracks which sessionIds have already had their blob URL revoked, so
// a duplicate TA_RELEASE_BLOB_URL (background.js retrying a message,
// or any other double-send) is recognized and logged as a harmless
// duplicate instead of silently behaving like a second legitimate
// release.
const releasedBlobUrls = new Set();

function diagLog(event, detail = {}) {
  try {
    const entry = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      context: "offscreen",
      instanceId: OFFSCREEN_INSTANCE_ID,
      event,
      detail
    };
    console.log("[TA-DIAG]", entry);
    chrome.runtime.sendMessage({ type: "TA_DIAG_LOG", entry }).catch(() => {});
  } catch (_) {}
}

function snapshotActiveSession() {
  if (!activeSession) return null;
  return {
    sessionId: activeSession.sessionId,
    mediaRecorderState: activeSession.mediaRecorder?.state || null,
    stopping: Boolean(activeSession.stopping),
    recordedChunkCount: activeSession.recordedChunks?.length || 0,
    micTrackStates: (activeSession.micStream?.getTracks() || []).map((t) => t.readyState),
    tabTrackStates: (activeSession.tabStream?.getTracks() || []).map((t) => t.readyState),
    // Phase 2 addition: needed by background.js's watchdog to compute
    // elapsed recording duration from the one authoritative source
    // (this session), rather than trusting a separately-tracked
    // start time. Same object, one more existing field — not a
    // second representation of session state.
    startTime: activeSession.startTime || null
  };
}

diagLog("offscreen_document_loaded", {});

window.addEventListener("pagehide", () => {
  diagLog("offscreen_document_pagehide", { activeSession: snapshotActiveSession() });
});
document.addEventListener("visibilitychange", () => {
  diagLog("offscreen_document_visibilitychange", { visibilityState: document.visibilityState });
});

// Diagnostic-only: attaches passive listeners to every track in a
// stream so we can see if/when the tab-capture or mic stream itself
// changes state mid-recording — none of these listeners alter the
// track or stream in any way.
function wireTrackDiagnostics(session, stream, label) {
  if (!stream) return;
  stream.getTracks().forEach((track) => {
    diagLog("track_captured", {
      sessionId: session.sessionId,
      label,
      kind: track.kind,
      readyState: track.readyState,
      muted: track.muted
    });
    track.addEventListener("ended", () => {
      diagLog("track_ended", {
        sessionId: session.sessionId,
        label,
        kind: track.kind,
        readyState: track.readyState
      });

      // Phase 2, Part C: the tab-capture track ending is the one
      // track-ended signal worth acting on — it's architecture-native
      // (Chrome only ends it when the captured tab genuinely closes or
      // navigates away) and much more reliable than content.js's
      // DOM-text meeting-ended heuristic. background.js owns the
      // grace-period/recovery decision (it already owns every other
      // stop trigger); this only notifies it that the tab track ended.
      // A microphone ending is deliberately NOT reported here — it can
      // end for reasons (device swap, OS permission change, hardware
      // hiccup) that have nothing to do with the class being over, and
      // must never trigger an automatic stop.
      if (label === "tab") {
        chrome.runtime.sendMessage({
          type: "TA_OFFSCREEN_TRACK_ENDED",
          sessionId: session.sessionId,
          label
        }).catch(() => {});
      } else if (label === "mixed") {
        // The mixed/destination stream is what MediaRecorder actually
        // consumes — if it ends on its own (not as a side effect of a
        // normal stop, which already tears streams down deliberately),
        // that's unusual enough to warrant its own distinctly-named
        // event rather than being just another "track_ended" line
        // among many. Logged only — no automatic action in this phase.
        diagLog("mixed_track_ended_unexpected", {
          sessionId: session.sessionId,
          kind: track.kind,
          readyState: track.readyState,
          stopping: Boolean(session.stopping)
        });
      }
    });
    track.addEventListener("mute", () => {
      diagLog("track_muted", { sessionId: session.sessionId, label });
    });
    track.addEventListener("unmute", () => {
      diagLog("track_unmuted", { sessionId: session.sessionId, label });
    });
  });
}

function createSessionState(sessionId) {
  return {
    sessionId,
    mediaRecorder: null,
    recordedChunks: [],
    micStream: null,
    tabStream: null,
    mixedStream: null,
    audioContext: null,
    tabAudioElement: null,
    startTime: null,
    // True only when both mic and tab audio were available and the
    // recording graph was wired for true stereo (mic on channel 0, tab
    // on channel 1) — used after stop to decide whether channel-count
    // validation is meaningful.
    expectStereo: false,
    // Per-session, not global: guards against a duplicate STOP for
    // this exact session without blocking a stop/start for any other
    // session.
    stopping: false
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Small control message from background.js: the download it started
  // from this session's blobUrl reached a terminal state, so it's now
  // safe to release the Blob. Only ever sent by background.js, never
  // assumed — see handleOffscreenStopComplete()/the downloads-tracking
  // logic there for exactly when this fires.
  if (message?.type === "TA_RELEASE_BLOB_URL") {
    const sessionId = message.sessionId;

    if (sessionId && releasedBlobUrls.has(sessionId)) {
      diagLog("blob_release_duplicate_ignored", { sessionId, alreadyReleased: true });
      return false;
    }

    const cached = sessionId ? finalizedResults.get(sessionId) : null;
    diagLog("blob_release_requested", { sessionId, tracked: Boolean(cached?.blobUrl), reason: message.reason || null });

    if (cached?.blobUrl) {
      try {
        URL.revokeObjectURL(cached.blobUrl);
        if (sessionId) releasedBlobUrls.add(sessionId);
        diagLog("blob_url_revoked", { sessionId, blobUrl: cached.blobUrl, reason: message.reason || null });
      } catch (error) {
        diagLog("blob_url_revoke_failed", { sessionId, error: String(error) });
      }
    } else {
      diagLog("blob_url_release_no_match", { sessionId });
    }
    return false;
  }

  // Phase 2, Part A: lets background.js ask what is actually recording
  // right now, instead of trusting a caller-supplied sessionId. Reuses
  // snapshotActiveSession() — the same function already used for every
  // diagnostic entry above — rather than a second representation of
  // session state. Synchronous: activeSession is a plain in-memory
  // pointer, no await needed.
  if (message?.type === "TA_OFFSCREEN_GET_ACTIVE_SESSION") {
    sendResponse({ ok: true, activeSession: snapshotActiveSession() });
    return false;
  }

  // Phase 2, Part B: crash recovery. Only ever invoked by background.js
  // at startup for a durable session it has already confirmed is NOT
  // the current activeSession (see the recovery scan in background.js)
  // — this never competes with or interrupts a genuinely live
  // recording.
  if (message?.type === "TA_OFFSCREEN_RECOVER_SESSION") {
    recoverSessionFromDurableChunks({
      sessionId: message.sessionId,
      lessonId: message.lessonId || null
    })
      .then((result) => sendResponse(result))
      .catch((error) => {
        diagLog("chunk_store_recovery_threw", { sessionId: message.sessionId, error: String(error) });
        sendResponse({ ok: false, sessionId: message.sessionId, reason: "RECOVERY_THREW", error: String(error) });
      });
    return true;
  }

  // Important: ignore all non-offscreen messages.
  // chrome.runtime.sendMessage broadcasts to extension contexts, so if the
  // offscreen document answers TA_START_REAL_RECORDING with UNKNOWN_MESSAGE
  // before the background service worker responds, the real recorder breaks.
  if (message?.type !== "TA_OFFSCREEN_START_RECORDING" && message?.type !== "TA_OFFSCREEN_STOP_RECORDING") {
    return false;
  }

  diagLog("offscreen_message_received", {
    type: message.type,
    sessionId: message.sessionId || message.payload?.sessionId || null,
    activeSession: snapshotActiveSession()
  });

  (async () => {
    try {
      if (message.type === "TA_OFFSCREEN_START_RECORDING") {
        const response = await startRecording(message);
        diagLog("offscreen_message_responded", { type: message.type, response: { ok: response?.ok, reason: response?.reason } });
        sendResponse(response);
        return;
      }

      if (message.type === "TA_OFFSCREEN_STOP_RECORDING") {
        const response = requestStop(message.sessionId);
        diagLog("offscreen_message_responded", { type: message.type, response: { ok: response?.ok, reason: response?.reason, pending: response?.pending, alreadyStopping: response?.alreadyStopping } });
        sendResponse(response);
        return;
      }
    } catch (error) {
      diagLog("offscreen_message_handler_threw", { type: message.type, error: String(error) });
      sendResponse({ ok: false, reason: "OFFSCREEN_ERROR", error: String(error) });
    }
  })();

  return true;
});

async function startRecording({
  streamId,
  sessionId,
  lessonId = null,
  mimeType,
  mode = "mixed",
  tabAudioAvailable = true,
  tabAudioError = null
}) {
  if (
    activeSession &&
    activeSession.mediaRecorder &&
    activeSession.mediaRecorder.state === "recording"
  ) {
    return {
      ok: false,
      reason: "ALREADY_RECORDING"
    };
  }

  const session = createSessionState(sessionId || crypto.randomUUID());
  // Cached now because chrome.storage isn't available in this
  // document — finalizeStop() needs this later to save the artifact
  // directly to IndexedDB (see savePreparedAudioArtifact()).
  session.lessonId = lessonId || null;
  session.startTime = new Date().toISOString();

  if (streamId) {
    try {
      session.tabStream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: streamId
            }
          },
          video: false
        });
      wireTrackDiagnostics(session, session.tabStream, "tab");
    } catch (error) {
      tabAudioAvailable = false;
      tabAudioError = String(error);
      session.tabStream = null;

      console.warn(
        "TeachAssist tab audio capture failed; continuing mic-only:",
        error
      );
    }
  } else {
    tabAudioAvailable = false;
    tabAudioError =
      tabAudioError ||
      "No tab audio stream id available";
  }

  if (mode !== "tab-only") {
    try {
      session.micStream =
        await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false
        });
      wireTrackDiagnostics(session, session.micStream, "mic");
    } catch (error) {
      await cleanupSessionStreams(session);

      return {
        ok: false,
        reason: "MICROPHONE_CAPTURE_FAILED",
        error: String(error)
      };
    }
  }

  if (
    mode === "tab-only" &&
    !session.tabStream
  ) {
    await cleanupSessionStreams(session);

    return {
      ok: false,
      reason: "TAB_AUDIO_CAPTURE_FAILED",
      error:
        tabAudioError ||
        "No tab audio stream available"
    };
  }

  try {
    session.audioContext = new AudioContext();

    const destination =
      session.audioContext.createMediaStreamDestination();

    if (
      session.micStream &&
      session.tabStream
    ) {
      // Both sources available: true stereo. Mic always maps to
      // channel 0 (left), tab audio always maps to channel 1
      // (right) — a real ChannelMergerNode, not a summed mix.
      const micSource =
        session.audioContext.createMediaStreamSource(session.micStream);

      const tabSource =
        session.audioContext.createMediaStreamSource(session.tabStream);

      // Keep the meeting audio audible.
      tabSource.connect(session.audioContext.destination);

      const merger = session.audioContext.createChannelMerger(2);
      merger.channelInterpretation = "discrete";

      // connect(destination, outputIndex, inputIndex): mic into
      // merger input 0 (-> channel 0), tab into merger input 1
      // (-> channel 1).
      micSource.connect(merger, 0, 0);
      tabSource.connect(merger, 0, 1);

      destination.channelCount = 2;
      destination.channelCountMode = "explicit";
      destination.channelInterpretation = "discrete";

      merger.connect(destination);

      session.expectStereo = true;
    } else {
      // Only one source available — stereo channel separation isn't
      // meaningful, so keep the existing direct-connect behavior.
      if (session.micStream) {
        const micSource =
          session.audioContext.createMediaStreamSource(session.micStream);

        micSource.connect(destination);
      }

      if (session.tabStream) {
        const tabSource =
          session.audioContext.createMediaStreamSource(session.tabStream);

        // Keep the meeting audio audible.
        tabSource.connect(session.audioContext.destination);

        // Include the meeting audio in the recording.
        tabSource.connect(destination);
      }

      session.expectStereo = false;
    }

    session.mixedStream = destination.stream;
    // The mixed/destination stream is what MediaRecorder actually
    // consumes — if it ends, that's the most direct possible
    // explanation for an unexpected MediaRecorder stop.
    wireTrackDiagnostics(session, session.mixedStream, "mixed");
  } catch (error) {
    await cleanupSessionStreams(session);

    return {
      ok: false,
      reason: "AUDIO_MIX_FAILED",
      error: String(error)
    };
  }

  const supportedMimeType = pickMimeType(mimeType);

  try {
    session.mediaRecorder = new MediaRecorder(
      session.mixedStream,
      supportedMimeType ? { mimeType: supportedMimeType } : undefined
    );
  } catch (error) {
    await cleanupSessionStreams(session);

    return {
      ok: false,
      reason: "MEDIA_RECORDER_FAILED",
      error: String(error)
    };
  }

  // Phase 2, Part A (crash safety): the durable checkpoint record must
  // exist BEFORE MediaRecorder is allowed to start, per
  // RecordingChunkStore's own contract — a failure here is treated as
  // a hard failure of starting the recording at all, not a silent
  // fallback to memory-only recording (which would defeat the entire
  // purpose of this store: making crash recovery possible at all).
  try {
    await RecordingChunkStore.initSession({
      sessionId: session.sessionId,
      lessonId: session.lessonId,
      mimeType: session.mediaRecorder.mimeType || supportedMimeType || "audio/webm"
    });
  } catch (error) {
    await cleanupSessionStreams(session);

    diagLog("chunk_store_init_failed", {
      sessionId: session.sessionId,
      error: String(error)
    });

    return {
      ok: false,
      reason: "CHUNK_STORE_INIT_FAILED",
      error: String(error)
    };
  }

  // Monotonically increasing per-session sequence number for durable
  // chunk ordering — incremented synchronously in ondataavailable
  // below, so even overlapping in-flight durable writes each get a
  // unique, correctly-ordered number.
  session.chunkSequence = 0;

  session.mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      session.recordedChunks.push(event.data);

      // Phase 2, Part A: the durable, crash-safe checkpoint. Fire-
      // and-forget — RecordingChunkStore.putChunk() already catches
      // and durably records its own failures (see that file), and
      // this handler must never be delayed waiting on an IndexedDB
      // round trip, or subsequent ~1s chunks would back up behind it.
      const sequenceNumber = session.chunkSequence;
      session.chunkSequence += 1;
      RecordingChunkStore.putChunk({
        sessionId: session.sessionId,
        sequenceNumber,
        data: event.data
      }).catch((error) => {
        diagLog("chunk_store_put_chunk_threw", {
          sessionId: session.sessionId,
          sequenceNumber,
          error: String(error)
        });
      });
    }
  };

  // Diagnostic-only additions below. These use addEventListener (not
  // the .onX properties, which are already spoken for above/in
  // stopRecording()) so they run alongside the existing handlers
  // without replacing or delaying them. onstart/error/stop firing
  // unexpectedly (i.e. without stopRecording() having been called)
  // is exactly the signal we're looking for.
  session.mediaRecorder.addEventListener("start", () => {
    diagLog("mediarecorder_start", { sessionId: session.sessionId });
  });
  session.mediaRecorder.addEventListener("error", (event) => {
    diagLog("mediarecorder_error", {
      sessionId: session.sessionId,
      error: String(event?.error || event)
    });
  });
  session.mediaRecorder.addEventListener("stop", () => {
    diagLog("mediarecorder_stop_event", {
      sessionId: session.sessionId,
      calledViaStopRecording: session.stopping,
      chunkCount: session.recordedChunks.length
    });
  });

  // Lightweight, throttled checkpoint so a 50+ minute recording
  // doesn't produce one log line per second — logs the 1st chunk,
  // then roughly every 30s, plus a running total.
  let diagChunkCount = 0;
  session.mediaRecorder.addEventListener("dataavailable", () => {
    diagChunkCount += 1;
    if (diagChunkCount === 1 || diagChunkCount % 30 === 0) {
      // Phase 2, Part D: added elapsedMs/approxBytes to this existing,
      // already-throttled checkpoint so a long recording's diagnostic
      // trail actually shows duration and size trending toward
      // anything concerning — without adding a new high-frequency
      // event or an independent size-based stop mechanism. Same
      // cadence as before (1st chunk, then every 30th).
      const elapsedMs = session.startTime
        ? Date.now() - Date.parse(session.startTime)
        : null;
      const approxBytes = session.recordedChunks.reduce(
        (sum, chunk) => sum + (chunk?.size || 0),
        0
      );
      diagLog("mediarecorder_chunk_checkpoint", {
        sessionId: session.sessionId,
        chunkCount: diagChunkCount,
        recorderState: session.mediaRecorder?.state || null,
        tabTrackStates: (session.tabStream?.getTracks() || []).map((t) => t.readyState),
        micTrackStates: (session.micStream?.getTracks() || []).map((t) => t.readyState),
        mixedTrackStates: (session.mixedStream?.getTracks() || []).map((t) => t.readyState),
        elapsedMs,
        approxBytes
      });
    }
  });

  session.mediaRecorder.start(1000);

  // Only now — once the session is fully set up and genuinely
  // recording — does it become the active session. A previous
  // session's stopRecording() already detached itself before this
  // point (see below), so there is never a moment where two sessions
  // both believe they own "the" active recorder state.
  activeSession = session;

  return {
    ok: true,
    sessionId: session.sessionId,
    startedAt: session.startTime,
    mimeType:
      session.mediaRecorder.mimeType ||
      supportedMimeType ||
      "audio/webm",
    mode,
    tabAudioAvailable,
    warning:
      tabAudioAvailable
        ? null
        : "TAB_AUDIO_UNAVAILABLE",
    tabAudioError:
      tabAudioAvailable
        ? null
        : tabAudioError
  };
}

function requestStop(sessionId) {
  // A completed finalization for this session is authoritative —
  // always answer with it, whether this is a legitimate late arrival
  // or a duplicate that shouldn't have been sent. This is what stops
  // a slow-but-successful stop from ever being overwritten by a
  // second, redundant stop request.
  if (sessionId && finalizedResults.has(sessionId)) {
    diagLog("stop_recording_duplicate_after_complete", { sessionId });
    return finalizedResults.get(sessionId);
  }

  // A finalization for this session is already running — don't touch
  // activeSession or MediaRecorder again, just tell the caller it's
  // already in progress. This is the exact case that used to produce
  // a false NOT_RECORDING: a second stop request arriving while the
  // first was still building the Blob.
  if (sessionId && finalizationPromises.has(sessionId)) {
    diagLog("stop_recording_duplicate_in_progress", { sessionId });
    return { ok: true, pending: true, alreadyStopping: true, sessionId };
  }

  const session =
    sessionId
      ? (activeSession && activeSession.sessionId === sessionId ? activeSession : null)
      : activeSession;

  // Diagnostic: this is the single most important checkpoint for the
  // NOT_RECORDING investigation — the exact state of activeSession and
  // the requested session, at the moment a stop was actually attempted.
  diagLog("stop_recording_requested", {
    requestedSessionId: sessionId || null,
    activeSessionId: activeSession?.sessionId || null,
    resolvedSessionMatch: Boolean(session),
    activeSession: snapshotActiveSession()
  });

  if (
    !session ||
    !session.mediaRecorder ||
    session.mediaRecorder.state !== "recording"
  ) {
    diagLog("stop_recording_not_recording", {
      requestedSessionId: sessionId || null,
      reason: !session ? "no_matching_session" : !session.mediaRecorder ? "no_media_recorder" : "recorder_not_in_recording_state",
      mediaRecorderState: session?.mediaRecorder?.state || null
    });
    return {
      ok: false,
      reason: "NOT_RECORDING"
    };
  }

  if (session.stopping) {
    // A duplicate stop for the exact same session that arrived before
    // it was registered in finalizationPromises yet (shouldn't happen
    // in practice now, but kept as a defensive idempotent no-op).
    return {
      ok: true,
      alreadyStopping: true,
      sessionId: session.sessionId
    };
  }
  session.stopping = true;

  // DETACH: release the "active" pointer immediately, before any
  // asynchronous work. This is what allows a new startRecording() to
  // begin right away.
  if (activeSession === session) {
    activeSession = null;
  }

  const recorder = session.mediaRecorder;

  try {
    recorder.stop();
  } catch (error) {
    const failure = {
      ok: false,
      reason: "MEDIA_RECORDER_STOP_FAILED",
      error: String(error),
      sessionId: session.sessionId
    };
    finalizedResults.set(session.sessionId, failure);
    diagLog("stop_recording_stop_threw", { sessionId, error: String(error) });
    return failure;
  }

  // Everything from here — waiting for the real "stop" event, building
  // the Blob, base64-encoding it, running stereo validation — happens
  // independently of this message's response. This is the actual fix:
  // an hour-long recording can take 15-20+ seconds to finalize, and
  // that used to hold this exact message open for that whole time,
  // which is what made a slow-but-successful stop look like a failed
  // one to background.js.
  const finalizationPromise = finalizeStop(session)
    .then((result) => {
      finalizedResults.set(session.sessionId, result);
      finalizationPromises.delete(session.sessionId);
      pushStopComplete(session.sessionId, result);
      return result;
    })
    .catch((error) => {
      const failure = {
        ok: false,
        reason: "FINALIZATION_FAILED",
        error: String(error),
        sessionId: session.sessionId
      };
      finalizedResults.set(session.sessionId, failure);
      finalizationPromises.delete(session.sessionId);
      pushStopComplete(session.sessionId, failure);
      return failure;
    });

  finalizationPromises.set(session.sessionId, finalizationPromise);

  return { ok: true, pending: true, sessionId: session.sessionId };
}

// Pushes the real, settled result to background.js as its own message,
// independent of whatever is or isn't still waiting on the original
// TA_OFFSCREEN_STOP_RECORDING response. This is what keeps a
// successful recording authoritative even if the original caller
// already moved on for any reason (including background.js's own
// message channel appearing to time out during the long wait this
// split is specifically meant to avoid).
function pushStopComplete(sessionId, result) {
  diagLog("offscreen_pushing_stop_complete", { sessionId, ok: result?.ok, reason: result?.reason || null });
  chrome.runtime.sendMessage({
    type: "TA_OFFSCREEN_STOP_COMPLETE",
    sessionId,
    result
  }).then(() => {
    diagLog("stop_complete_sent", { sessionId, ok: result?.ok });
  }).catch((error) => {
    diagLog("stop_complete_send_failed", { sessionId, error: String(error) });
  });
}

async function finalizeStop(session) {
  const recorder = session.mediaRecorder;
  const chunks = session.recordedChunks;
  const resolvedSessionId = session.sessionId;
  const startedAt = session.startTime;
  const expectStereo = session.expectStereo;
  const stoppedAt = new Date().toISOString();

  await new Promise((resolve) => {
    // recorder.stop() was already called by requestStop() just before
    // finalizeStop() started running — if the "stop" event already
    // fired synchronously in some engine, fall back to the recorder's
    // own state instead of waiting on an event that will never come.
    if (recorder.state === "inactive") {
      resolve();
      return;
    }
    recorder.onstop = resolve;
  });

  diagLog("finalize_stop_recorder_stopped", { sessionId: resolvedSessionId, chunkCount: chunks.length });

  const blob = new Blob(
    chunks,
    {
      type: recorder.mimeType || "audio/webm"
    }
  );
  diagLog("blob_created", { sessionId: resolvedSessionId, sizeBytes: blob.size, chunkCount: chunks.length });

  // No base64 conversion, and no full-audio message: createObjectURL is
  // an instant, fixed-size reference into memory this document already
  // owns. It's what gets pushed to background.js — not the audio
  // itself — which is what keeps this whole path independent of
  // recording length.
  const blobUrl = URL.createObjectURL(blob);
  diagLog("blob_url_created", { sessionId: resolvedSessionId, sizeBytes: blob.size, blobUrl });

  // Decode the recorded blob to confirm it actually has 2 discrete
  // channels before anything downstream can rely on channel-based
  // separation. Only meaningful when both mic and tab audio were
  // available and the graph was wired for stereo — with a single
  // source, mono is the correct, expected result and is not a
  // warning.
  const stereoValidation = expectStereo
    ? await validateStereoAudio(blob)
    : null;

  // Same Blob, second consumer: saved directly into IndexedDB here —
  // in this document, never through messaging — so the transcription/
  // dashboard pipeline gets the exact recording chrome.downloads is
  // also about to save, not a second, independently-built copy.
  // Non-fatal on failure: the tutor-visible lesson.webm save does not
  // depend on this succeeding.
  const artifactSaved = await savePreparedAudioArtifact({
    session,
    blob,
    expectStereo,
    stereoValidation
  });

  await cleanupSessionStreams(session);

  diagLog("finalize_stop_complete", { sessionId: resolvedSessionId, sizeBytes: blob.size, artifactSaved });

  // Phase 2, Part A: only now — after the lesson.webm-equivalent blob
  // has been fully built and the IndexedDB artifact save has been
  // attempted — is it safe to retire the durable chunk checkpoint.
  // Deliberately best-effort and non-fatal: if this fails, the worst
  // outcome is a harmless leftover durable session that a future
  // startup's recovery scan will skip anyway, because its status is
  // no longer RECORDING. Never gates the real stop outcome below.
  try {
    await RecordingChunkStore.markSessionStatus(
      resolvedSessionId,
      RecordingChunkStore.SESSION_STATUS.RECONSTRUCTED
    );
    await RecordingChunkStore.deleteChunksForSession(resolvedSessionId);
  } catch (error) {
    diagLog("chunk_store_cleanup_failed", { sessionId: resolvedSessionId, error: String(error) });
  }

  return {
    ok: true,
    sessionId: resolvedSessionId,
    startedAt,
    stoppedAt,
    mimeType: blob.type || "audio/webm",
    sizeBytes: blob.size,
    blobUrl,
    expectStereo,
    stereoValidation,
    artifactSaved
  };
}

// Saves the finalized Blob directly to IndexedDB via ArtifactService —
// the same services background.js loads via importScripts(), loaded
// here as plain <script> tags (see offscreen.html). This is the
// "second consumer" of the one Blob finalizeStop() builds: chrome.
// downloads gets a blobUrl reference, this gets the actual bytes
// written locally, and neither ever crosses chrome.runtime.sendMessage.
async function savePreparedAudioArtifact({ session, blob, expectStereo, stereoValidation }) {
  if (!session.lessonId) {
    // Can happen for a session started before this fix, or if
    // registerSessionMetadata() genuinely never ran. The lesson.webm
    // save via chrome.downloads is unaffected either way.
    diagLog("artifact_save_skipped_no_lesson_id", { sessionId: session.sessionId });
    return false;
  }

  try {
    await ArtifactService.savePreparedAudio({
      lessonId: session.lessonId,
      data: blob,
      mimeType: blob.type || "audio/webm",
      sizeBytes: blob.size,
      filename: "lesson.webm",
      verified: true,
      verificationMethod: "size",
      metadata: {
        expectStereo: Boolean(expectStereo),
        stereoValidation: stereoValidation || null
      }
    });
    diagLog("artifact_saved_to_indexeddb", { sessionId: session.sessionId, lessonId: session.lessonId, sizeBytes: blob.size });
    return true;
  } catch (error) {
    diagLog("artifact_save_failed", { sessionId: session.sessionId, lessonId: session.lessonId, error: String(error) });
    return false;
  }
}

// Decodes the recorded blob with a short-lived AudioContext (separate
// from the recording graph's AudioContext) solely to confirm its real
// channel count.
// Phase 2, Part B: reconstructs a session's audio purely from durable
// RecordingChunkStore data — used only for crash recovery, when
// activeSession itself is gone (the offscreen document that held it
// was destroyed) and the only remaining record of the recording is
// what was checkpointed to IndexedDB while it was running. Reuses
// savePreparedAudioArtifact() unchanged — the same function normal
// finalizeStop() uses — and returns a result in the exact same shape
// finalizeStop() returns, so background.js can feed it into its
// existing handleOffscreenStopComplete() path without any new
// finalization logic on that side either.
async function recoverSessionFromDurableChunks({ sessionId, lessonId }) {
  const { chunks, chunkCount, expectedCount, gaps, mimeType } =
    await RecordingChunkStore.getChunksForSession(sessionId);

  if (!chunks || chunks.length === 0) {
    diagLog("chunk_store_recovery_no_chunks", { sessionId });
    return { ok: false, sessionId, reason: "NO_DURABLE_CHUNKS" };
  }

  const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
  diagLog("chunk_store_recovery_blob_built", {
    sessionId,
    sizeBytes: blob.size,
    chunkCount,
    expectedCount,
    gapCount: gaps.length
  });

  const blobUrl = URL.createObjectURL(blob);

  const artifactSaved = await savePreparedAudioArtifact({
    session: { sessionId, lessonId },
    blob,
    expectStereo: false,
    stereoValidation: null
  });

  return {
    ok: true,
    sessionId,
    lessonId,
    mimeType: blob.type || "audio/webm",
    sizeBytes: blob.size,
    blobUrl,
    expectStereo: false,
    stereoValidation: null,
    stoppedAt: new Date().toISOString(),
    artifactSaved,
    chunkCount,
    expectedCount,
    gaps
  };
}

async function validateStereoAudio(blob) {
  if (!blob || blob.size === 0) {
    return {
      ok: false,
      numberOfChannels: 0,
      error: "The recording is empty."
    };
  }

  let validationContext = null;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    validationContext = new AudioContext();
    const audioBuffer = await validationContext.decodeAudioData(arrayBuffer);

    return {
      ok: audioBuffer.numberOfChannels === 2,
      numberOfChannels: audioBuffer.numberOfChannels,
      error:
        audioBuffer.numberOfChannels === 2
          ? null
          : `Expected 2 channels, decoded audio has ${audioBuffer.numberOfChannels}.`
    };
  } catch (error) {
    return {
      ok: false,
      numberOfChannels: 0,
      error: `Could not decode the recording to verify stereo channels: ${String(error)}`
    };
  } finally {
    if (validationContext) {
      await validationContext.close().catch(() => {});
    }
  }
}

function pickMimeType(preferred) {
  const candidates = [
    preferred,
    "audio/webm;codecs=opus",
    "audio/webm",
    "video/webm;codecs=opus",
    "video/webm"
  ].filter(Boolean);

  return candidates.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch (_) {
      return false;
    }
  }) || "";
}

// Tears down exactly one session's own streams/context — never
// touches any other session's state. Safe to call even if this
// session's mediaRecorder is already inactive (used both on error
// paths before recording starts and after a successful stop).
async function cleanupSessionStreams(session) {
  if (!session) return;

  diagLog("cleanup_session_streams", {
    sessionId: session.sessionId,
    mediaRecorderState: session.mediaRecorder?.state || null,
    recordedChunkCount: session.recordedChunks?.length || 0
  });

  try {
    if (
      session.mediaRecorder &&
      session.mediaRecorder.state === "recording"
    ) {
      session.mediaRecorder.stop();
    }
  } catch (_) {}

  [
    session.micStream,
    session.tabStream,
    session.mixedStream
  ].forEach((stream) => {
    try {
      stream
        ?.getTracks?.()
        .forEach((track) => track.stop());
    } catch (_) {}
  });

  try {
    if (
      session.audioContext &&
      session.audioContext.state !== "closed"
    ) {
      await session.audioContext.close();
    }
  } catch (_) {}

  try {
    if (session.tabAudioElement) {
      session.tabAudioElement.pause();
      session.tabAudioElement.srcObject = null;
    }
  } catch (_) {}

  session.mediaRecorder = null;
  session.recordedChunks = [];
  session.micStream = null;
  session.tabStream = null;
  session.mixedStream = null;
  session.audioContext = null;
  session.tabAudioElement = null;
}