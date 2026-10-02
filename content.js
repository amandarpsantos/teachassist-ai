(() => {
  if (window.__teachAssistAiLoaded) return;
  window.__teachAssistAiLoaded = true;

  const APP_ID = "teachassist-ai-root";
  const BANNER_ID = "teachassist-ai-banner";
  const BADGE_ID = "teachassist-ai-badge";

  const platform = detectPlatform(location.href);
  if (!platform) return;

  const state = {
    activeMeeting: false,
    isRecording: false,

    sessionId: null,
    currentSession: null,
    startedAt: null,
    timerInterval: null,
    elapsedSeconds: 0,
    badgeCollapsed: false,
    badgePosition: null,
    bannerDismissed: false,
    reminderTimers: [],
    reminderStage: 0,
    activeMeetingCheckInterval: null,
    currentGroup: null,
    sessionCountInGroup: 0,
    // Per-session, not a single global flag: tracks which sessionId(s)
    // currently have a stop in progress, so finalizing one session
    // (which can take a while — it awaits the full offscreen
    // finalization) never blocks stopping a different, later session.
    // A duplicate stop for the SAME session is still a safe no-op via
    // the isRecording check below, same as before.
    stoppingSessionIds: new Set(),
    // Phase 1 start-dedup lock: holds the in-flight startRecording()
    // Promise (or null when no start is in progress). Overlapping
    // callers (badge click, popup, keyboard shortcut) await this same
    // Promise instead of independently generating a new session ID,
    // registering metadata again, or starting a second real recording.
    // Covers only the duration of the start attempt itself — cleared
    // as soon as that attempt settles, well before the resulting
    // recording is stopped, so a later class can always start normally.
    startInFlight: null,
};

  // ---- Diagnostic-only instrumentation (temporary) ----
  // Added to root-cause the "End call for everyone" recording-loss
  // bug. Fire-and-forget, wrapped so it can never throw into or delay
  // any real logic, and changes nothing about recording behavior.
  // Safe to remove once the root cause is confirmed.
  //
  // CONTENT_INSTANCE_ID is fresh per page load. If Meet navigates the
  // tab (as it does for "End the call for everyone" -> post-call
  // screen), the old content.js context is destroyed and a brand-new
  // one is injected into the new page with a different instance id —
  // a second "content_script_loaded" for the same tab during what
  // should be one continuous class is the direct signal that
  // happened.
  const CONTENT_INSTANCE_ID = crypto.randomUUID();

  function diagLog(event, detail = {}) {
    try {
      const entry = {
        ts: Date.now(),
        iso: new Date().toISOString(),
        context: "content",
        instanceId: CONTENT_INSTANCE_ID,
        event,
        detail
      };
      console.log("[TA-DIAG]", entry);
      chrome.runtime.sendMessage({ type: "TA_DIAG_LOG", entry }).catch(() => {});
    } catch (_) {}
  }

  diagLog("content_script_loaded", { url: location.href });

  init();

  function detectPlatform(url) {
    if (/^https:\/\/meet\.google\.com\//.test(url)) return "Google Meet";
    if (/^https:\/\/teams\.microsoft\.com\//.test(url)) return "Microsoft Teams";
    if (/^https:\/\/teams\.live\.com\//.test(url)) return "Microsoft Teams";
    return null;
  }

  async function init() {
    injectStyles();
    ensureRoot();
    wireMessages();
    startMeetingMonitor();
    window.addEventListener("pagehide", () => {
      // Logged first, synchronously, before anything else — this
      // fires even if the async stop attempt below never gets a
      // chance to complete before the page context is torn down.
      diagLog("pagehide_fired", { isRecording: state.isRecording, sessionId: state.sessionId, url: location.href });
      if (state.isRecording) {
        stopRecording("tab_closed");
      }
    });
  }

  function ensureRoot() {
    if (document.getElementById(APP_ID)) return;
    const root = document.createElement("div");
    root.id = APP_ID;
    document.documentElement.appendChild(root);
  }

  function startMeetingMonitor() {
    updateActiveMeetingUi();
    state.activeMeetingCheckInterval = setInterval(updateActiveMeetingUi, 1500);
    const observer = new MutationObserver(() => updateActiveMeetingUi());
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }

  function detectActiveMeeting() {
    const text = (document.body?.innerText || "").toLowerCase();
    if (/you\'ve ended the meeting|you have ended the meeting|you left the meeting|return to home screen|meeting ended|call ended/.test(text)) return false;
    const controls = Array.from(document.querySelectorAll('button,[role="button"]'));
    const labels = controls.map((el) => `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.textContent || ""}`.toLowerCase()).join(" | ");

    if (platform === "Google Meet") {
      // Active call normally has a hang-up / leave-call control. The lobby/start screen usually does not.
      if (/leave call|leave meeting|end call|hang up/.test(labels)) return true;
      if (document.querySelector('[aria-label*="Leave call"], [aria-label*="leave call"], [data-tooltip*="Leave call"]')) return true;
      return false;
    }

    if (platform === "Microsoft Teams") {
      if (/leave( call| meeting)?|hang up|end call/.test(labels)) return true;
      if (document.querySelector('[data-tid*="call-hangup"], [aria-label*="Leave"], [title*="Leave"]')) return true;
      return false;
    }

    return false;
  }

  function updateActiveMeetingUi() {
    const active = detectActiveMeeting();
    if (active === state.activeMeeting) return;
    diagLog("meeting_active_transition", {
      from: state.activeMeeting,
      to: active,
      isRecording: state.isRecording,
      sessionId: state.sessionId,
      bodyTextSnippet: (document.body?.innerText || "").slice(0, 200)
    });
    state.activeMeeting = active;

    if (active) {
      showBanner();
      showBadge();
      notifyMeetingStateChanged();
      return;
    }

    if (state.isRecording) {
      // If the teacher ends the call while recording, finalize the session automatically.
      stopRecording("meeting_ended").finally(() => {
        removeBannerAndBadge();
        resetReminderWorkflow();
        state.currentGroup = null;
        state.sessionCountInGroup = 0;
        notifyMeetingStateChanged();
      });
      return;
    }

    removeBannerAndBadge();
    resetReminderWorkflow();
    state.currentGroup = null;
    state.sessionCountInGroup = 0;
    notifyMeetingStateChanged();
  }

  function removeBannerAndBadge() {
    document.getElementById(BANNER_ID)?.remove();
    document.getElementById(BADGE_ID)?.remove();
  }

  function resetReminderWorkflow() {
    clearReminderTimers();
    state.bannerDismissed = false;
    state.reminderStage = 0;
  }

  async function notifyMeetingStateChanged() {
    try {
      await chrome.runtime.sendMessage({
        type: "TA_MEETING_STATE_CHANGED",
        isMeeting: state.activeMeeting,
        isRecording: state.isRecording,
        platform
      });
    } catch (_) {
      // Background may be unavailable during page transitions; safe to ignore.
    }
  }

  function injectStyles() {
    if (document.getElementById("teachassist-ai-styles")) return;
    const style = document.createElement("style");
    style.id = "teachassist-ai-styles";
    style.textContent = `
      #${BANNER_ID}, #${BADGE_ID} { box-sizing: border-box; font-family: Inter, Arial, sans-serif; z-index: 2147483647; }
      #${BANNER_ID} {
        position: fixed; top: 18px; right: 18px; width: 310px; padding: 14px 16px;
        background: #0f172a; color: #fff; border-radius: 16px;
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.25); line-height: 1.35;
      }
      .ta-banner-title { font-weight: 800; font-size: 15px; margin-bottom: 4px; }
      .ta-banner-text { color: #cbd5e1; font-size: 13px; }
      .ta-banner-close { position: absolute; top: 9px; right: 10px; border: 0; background: transparent; color: #94a3b8; cursor: pointer; font-size: 18px; }
      #${BADGE_ID} {
        position: fixed; left: 24px; bottom: 24px; min-width: 112px;
        background: #111827; color: #fff; border-radius: 16px; padding: 10px 12px;
        box-shadow: 0 14px 35px rgba(0, 0, 0, 0.35); display: flex; gap: 10px; align-items: center;
        user-select: none; cursor: grab;
      }
      #${BADGE_ID}:active { cursor: grabbing; }
      .ta-badge-main { display: flex; align-items: center; gap: 8px; font-weight: 800; white-space: nowrap; }
      .ta-dot { width: 9px; height: 9px; border-radius: 50%; background: #10b981; display: inline-block; }
      .ta-dot.recording { background: #ff0050; animation: taPulse 1.2s infinite; }
      @keyframes taPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .55; transform: scale(1.25); } }
      .ta-badge-button { border: 0; border-radius: 999px; padding: 7px 12px; background: #ff0050; color: #fff; font-weight: 800; cursor: pointer; }
      .ta-badge-button.stop { background: #0b1020; border: 1px solid rgba(255,255,255,.22); }
      .ta-timer { font-size: 13px; color: #cbd5e1; font-variant-numeric: tabular-nums; }
      .ta-collapse { border: 0; background: transparent; color: #94a3b8; cursor: pointer; font-size: 16px; padding: 0 2px; }
      .ta-hidden { display: none !important; }
    `;
    document.documentElement.appendChild(style);
  }

  function showBanner() {
    if (!state.activeMeeting || state.isRecording || document.getElementById(BANNER_ID)) return;
    const banner = document.createElement("div");
    banner.id = BANNER_ID;
    banner.innerHTML = `
      <button class="ta-banner-close" title="Dismiss">×</button>
      <div class="ta-banner-title">TeachAssist AI is ready.</div>
      <div class="ta-banner-text">Press <strong>Ctrl+Shift+F</strong><br>to start recording.</div>
    `;
    banner.querySelector(".ta-banner-close").addEventListener("click", () => dismissBanner());
    document.body.appendChild(banner);
  }

  function dismissBanner() {
    document.getElementById(BANNER_ID)?.remove();
    state.bannerDismissed = true;
    clearReminderTimers();

    if (state.reminderStage === 0) {
      state.reminderStage = 1;
      scheduleReminder(2 * 60 * 1000);
      return;
    }

    if (state.reminderStage === 1) {
      state.reminderStage = 2;
      scheduleReminder(5 * 60 * 1000);
      return;
    }

    state.reminderStage = 3;
  }

  function scheduleReminder(delayMs) {
    const timerId = setTimeout(showReminderBanner, delayMs);
    state.reminderTimers.push(timerId);
  }

  function showReminderBanner() {
    if (!state.activeMeeting || state.isRecording || !state.bannerDismissed || state.reminderStage > 2) return;
    const existing = document.getElementById(BANNER_ID);
    if (existing) existing.remove();
    const banner = document.createElement("div");
    banner.id = BANNER_ID;
    const isFinalReminder = state.reminderStage === 2;
    banner.innerHTML = `
      <button class="ta-banner-close" title="Dismiss">×</button>
      <div class="ta-banner-title">${isFinalReminder ? "Final reminder: TeachAssist AI is not recording." : "TeachAssist AI is still not recording."}</div>
      <div class="ta-banner-text">Press <strong>Ctrl+Shift+F</strong><br>if this is a lesson.</div>
    `;
    banner.querySelector(".ta-banner-close").addEventListener("click", () => dismissBanner());
    document.body.appendChild(banner);
  }

  function clearReminderTimers() {
    state.reminderTimers.forEach(clearTimeout);
    state.reminderTimers = [];
  }

  function showBadge() {
    if (!state.activeMeeting && !state.isRecording) return;
    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
      badge = document.createElement("div");
      badge.id = BADGE_ID;
      document.body.appendChild(badge);
      makeDraggable(badge);
    }

    if (state.badgePosition) {
      badge.style.left = state.badgePosition.left;
      badge.style.top = state.badgePosition.top;
      badge.style.bottom = "auto";
    }

    renderBadge();
  }

  function renderBadge() {
    const badge = document.getElementById(BADGE_ID);
    if (!badge) return;
    const label = state.isRecording ? "REC" : "Ready";
    const buttonText = state.isRecording ? "Stop" : "Start";
    const buttonClass = state.isRecording ? "ta-badge-button stop" : "ta-badge-button";
    const timerClass = state.badgeCollapsed || !state.isRecording ? "ta-timer ta-hidden" : "ta-timer";
    const collapseSymbol = state.badgeCollapsed ? "▴" : "▾";

    badge.innerHTML = `
      <div class="ta-badge-main">
        <span class="ta-dot ${state.isRecording ? "recording" : ""}"></span>
        <span>${label}</span>
      </div>
      <button class="${buttonClass}" type="button">${buttonText}</button>
      <span class="${timerClass}">${formatTime(state.elapsedSeconds)}</span>
      <button class="ta-collapse" title="Collapse timer">${collapseSymbol}</button>
    `;

    badge.querySelector(".ta-badge-button").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleRecording();
    });
    badge.querySelector(".ta-collapse").addEventListener("click", async (event) => {
      event.stopPropagation();
      state.badgeCollapsed = !state.badgeCollapsed;
      await chrome.storage.local.set({ taBadgeCollapsed: state.badgeCollapsed });
      renderBadge();
    });
  }

  function makeDraggable(el) {
    let startX = 0, startY = 0, originX = 0, originY = 0, dragging = false;

    el.addEventListener("pointerdown", (event) => {
      if (event.target.tagName === "BUTTON") return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      const rect = el.getBoundingClientRect();
      originX = rect.left;
      originY = rect.top;
      el.setPointerCapture(event.pointerId);
    });

    el.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const x = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, originX + event.clientX - startX));
      const y = Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, originY + event.clientY - startY));
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.bottom = "auto";
    });

    el.addEventListener("pointerup", async () => {
      if (!dragging) return;
      dragging = false;
      await chrome.storage.local.set({ taBadgePosition: { left: el.style.left, top: el.style.top } });
    });
  }

  async function toggleRecording() {
      if (state.isRecording) {
        return await stopRecording();
      }
    
      return await startRecording();
    }

  // Phase 1 start-dedup lock. Overlapping callers (badge click, popup,
  // keyboard shortcut — see toggleRecording()'s callers) share the
  // same in-flight Promise instead of each independently generating a
  // new session ID, registering metadata again, or starting a second
  // real recording in startRecordingInternal(). The lock is cleared
  // the moment the start attempt settles (success, failure, or
  // exception) — it never covers the recording itself, so a
  // subsequent class starts through a completely fresh call once the
  // previous one has been stopped.
  async function startRecording() {
    if (state.startInFlight) {
      return state.startInFlight;
    }
    state.startInFlight = (async () => {
      try {
        return await startRecordingInternal();
      } finally {
        state.startInFlight = null;
      }
    })();
    return state.startInFlight;
  }

  async function startRecordingInternal() {
    updateActiveMeetingUi();
    if (!state.activeMeeting) return { ok: false, reason: "NO_ACTIVE_MEETING" };
    if (state.isRecording) return { ok: true, alreadyRecording: true };

    const now = new Date();
    state.sessionId = crypto.randomUUID();
    const attemptedSessionId = state.sessionId;
    state.startedAt = now.toISOString();
    try {
      state.currentSession = createSessionMetadata(now);
    } catch (error) {
      console.error("TeachAssist could not create session metadata:", error);
      resetCurrentSession(attemptedSessionId);
      return { ok: false, reason: "SESSION_METADATA_FAILED", error: String(error) };
    }

    // Register the session FIRST, and confirm it actually succeeded,
    // before ever starting the real recording. This is what
    // guarantees a valid lessonId exists by the time
    // TA_START_REAL_RECORDING reaches background.js's startRecorder()
    // — which looks the lessonId up from this exact registration,
    // and previously could run before this message had even been
    // sent. Real Promise-based ordering (this whole block is awaited
    // before the next one begins), not a timer.
    diagLog("session_metadata_registration_started", { sessionId: attemptedSessionId });

    let registeredLessonId = null;

try {
  const initialRegister = await chrome.runtime.sendMessage({
    type: "TA_REGISTER_SESSION_METADATA",
    payload: state.currentSession
  });

  if (!initialRegister?.ok) {
    throw new Error(
      initialRegister?.reason ||
      "metadata registration failed"
    );
  }

  registeredLessonId = initialRegister?.record?.lessonJson?.lessonId || null;

  diagLog("session_metadata_registered", {
    sessionId: attemptedSessionId,
    lessonId: registeredLessonId
  });

  if (!registeredLessonId) {
    // Registration itself reported success but didn't come back with
    // a lessonId — surfaced distinctly so a future real-world failure
    // here is immediately diagnosable, rather than only showing up
    // later as a silently skipped artifact save.
    diagLog("start_recording_missing_lesson_id", { sessionId: attemptedSessionId });
  }
} catch (error) {
  console.error(
    "TeachAssist could not register the lesson package:",
    error
  );

  showTemporaryError(
    "TeachAssist couldn't start recording. Please try again in a moment."
  );

  resetCurrentSession(attemptedSessionId);

  return {
    ok: false,
    reason: "LOCAL_PACKAGE_REGISTER_FAILED",
    error: String(error)
  };
}

    let realRecording = null;

diagLog("start_recording_requested", {
  sessionId: attemptedSessionId,
  lessonId: registeredLessonId
});

try {
  realRecording = await chrome.runtime.sendMessage({
    type: "TA_START_REAL_RECORDING",
    payload: {
      sessionId: attemptedSessionId,
      mode: "mixed"
    }
  });

  diagLog("start_recording_received", {
    sessionId: attemptedSessionId,
    lessonId: registeredLessonId,
    ok: Boolean(realRecording?.ok),
    reason: realRecording?.reason || null
  });

  if (!realRecording?.ok) {
    throw new Error(
      realRecording?.reason ||
      realRecording?.error ||
      "mixed recording failed"
    );
  }

} catch (error) {
  console.error("TeachAssist could not start recording:", error);

  showTemporaryError(
    "TeachAssist couldn't start recording. Please start from the extension popup, allow microphone access, and keep the meeting tab active."
  );

  resetCurrentSession(attemptedSessionId);

  return {
    ok: false,
    reason: "RECORDING_START_FAILED",
    error: String(error)
  };
}

    state.isRecording = true;
    state.elapsedSeconds = 0;
    document.getElementById(BANNER_ID)?.remove();
    clearReminderTimers();
    state.bannerDismissed = false;
    state.reminderStage = 0;
    state.timerInterval = setInterval(() => {
      state.elapsedSeconds += 1;
      renderBadge();
    }, 1000);
    showBadge();
    renderBadge();
    await chrome.runtime.sendMessage({ type: "TA_RECORDING_STATE_CHANGED", isRecording: true, sessionId: attemptedSessionId, isMeeting: state.activeMeeting, platform });
    return { ok: true, realRecording };
  }

  async function stopRecording(reason = "manual_stop") {
    if (!state.isRecording) return { ok: true, alreadyStopped: true };
    if (state.stoppingSessionIds.has(state.sessionId)) {
      return { ok: false, reason: "STOP_ALREADY_IN_PROGRESS" };
    }
    state.stoppingSessionIds.add(state.sessionId);
    state.isRecording = false;
    clearInterval(state.timerInterval);
    state.timerInterval = null;

    const completedSessionId = state.sessionId;
    const stoppedAt = new Date().toISOString();
    const session = state.currentSession || createSessionMetadata(new Date(state.startedAt || Date.now()));
    session.lessonJson.stoppedAt = stoppedAt;
    session.lessonJson.durationSeconds = Math.max(0, state.elapsedSeconds);
    session.lessonJson.stopReason = reason;

    let recordingResult = null;

    diagLog("stop_message_sending", { sessionId: completedSessionId, reason });

try {
  const recording = await chrome.runtime.sendMessage({
    type: "TA_STOP_REAL_RECORDING",
    payload: {
      groupFolderName: session.groupFolderName,
      sessionFolderName: session.sessionFolderName,
      sessionId: completedSessionId,
      stopReason: reason
    }
  });

  diagLog("stop_message_response_received", {
    sessionId: completedSessionId,
    ok: recording?.ok,
    reason: recording?.reason || null,
    error: recording?.error || null
  });

  if (!recording?.ok) {
    // Preserve the reason code and the underlying error detail as two
    // separate fields instead of collapsing them into one thrown
    // Error — `reason || error` previously discarded whichever one
    // lost that `||`, which is why status.json only ever showed
    // "Error: OFFSCREEN_STOP_FAILED" with no way to tell a message-port
    // delivery failure apart from an offscreen NOT_RECORDING response.
    recordingResult = {
      ok: false,
      reason: recording?.reason || "REAL_RECORDING_STOP_FAILED",
      error: recording?.error || recording?.reason || "mixed recording stop failed"
    };
  } else {
    recordingResult = recording;
  }
} catch (error) {
  diagLog("stop_message_send_threw", { sessionId: completedSessionId, error: String(error) });
  // chrome.runtime.sendMessage itself failed to reach background.js
  // (e.g. the extension is reloading) — a different failure class
  // than background.js returning a structured !ok result above.
  recordingResult = {
    ok: false,
    reason: "REAL_RECORDING_STOP_FAILED",
    error: String(error)
  };
}

if (recordingResult?.ok) {
  session.lessonJson.recordingFilename = "lesson.webm";

  session.lessonJson.recordingFile = {
    filename: recordingResult.filename || "lesson.webm",
    mimeType: recordingResult.mimeType,
    sizeBytes: recordingResult.sizeBytes
  };

  session.lessonJson.recordingSource = "mixed";
  session.lessonJson.expectStereo = Boolean(recordingResult.expectStereo);
  session.lessonJson.stereoValidation = recordingResult.stereoValidation || null;

  session.statusJson.state = "waiting_for_upload";

  session.statusJson.currentStep =
    reason === "manual_stop"
      ? "Mixed recording saved"
      : `Mixed recording saved after automatic stop: ${reason}`;

  const stereoWarning =
    recordingResult.expectStereo &&
    recordingResult.stereoValidation &&
    !recordingResult.stereoValidation.ok
      ? [
          {
            reason: "STEREO_CHANNEL_SEPARATION_FAILED",
            error:
              "Recording saved, but microphone and tab audio could not be verified as separate stereo channels " +
              `(${recordingResult.stereoValidation.error || "channel check failed"}). ` +
              "The audio file is still usable; channel-based speaker separation may not be reliable for this lesson.",
            timestamp: stoppedAt,
            sessionId: session.lessonJson.sessionId || completedSessionId || null
          }
        ]
      : [];

  session.statusJson.errors = stereoWarning;
} else {
  session.statusJson.state = "needs_attention";
  session.statusJson.currentStep =
    "Recording file could not be saved";

  // Preserve both the reason code and the underlying error detail —
  // previously `reason || error` silently discarded the underlying
  // message whenever a reason code was present (which was always,
  // since every failure path sets one), making it impossible to
  // distinguish a message-port failure from an offscreen
  // NOT_RECORDING response after the fact.
  session.statusJson.errors = [
    {
      reason: recordingResult?.reason || "RECORDING_STOP_FAILED",
      error: recordingResult?.error || null,
      timestamp: stoppedAt,
      sessionId: session.lessonJson.sessionId || completedSessionId || null
    }
  ];
}
    session.statusJson.lastUpdated = stoppedAt;

    if (state.currentGroup) {
      state.currentGroup.updatedAt = stoppedAt;
      session.groupJson = { ...state.currentGroup, sessions: [...state.currentGroup.sessions] };
    }

    let saveResult = null;
    if (!recordingResult?.ok) {
      // On success, background.js's stopRecorder() has already
      // persisted the finalized lesson/status metadata itself (see
      // finalizeSuccessfulStop() in background.js) — content.js is no
      // longer required to survive and make a second
      // TA_SAVE_SESSION_METADATA call for that to be durable. The
      // needs_attention/failure path still isn't covered by that, so
      // it's still saved here.
      try {
        saveResult = await chrome.runtime.sendMessage({ type: "TA_SAVE_SESSION_METADATA", payload: session });
      } catch (error) {
        session.statusJson.state = "metadata_save_failed";
        session.statusJson.errors = [
          {
            reason: "METADATA_SAVE_FAILED",
            error: String(error),
            timestamp: new Date().toISOString(),
            sessionId: completedSessionId || session.lessonJson?.sessionId || null
          }
        ];
        console.warn("TeachAssist metadata save failed:", error);
      }
    }

    resetCurrentSession(completedSessionId);
    state.stoppingSessionIds.delete(completedSessionId);
    renderBadge();
    await chrome.runtime.sendMessage({ type: "TA_RECORDING_STATE_CHANGED", isRecording: false, sessionId: completedSessionId, isMeeting: state.activeMeeting, platform });
    notifyMeetingStateChanged();
    return { ok: true, saveResult };
  }

  function resetCurrentSession(expectedSessionId) {
      // If a newer session has already taken over state.sessionId
      // (this cleanup is running after crossing an await, and a new
      // recording started in the meantime), do not clear it out from
      // under that newer, still-active session.
      if (expectedSessionId !== undefined && state.sessionId !== expectedSessionId) {
        return;
      }
      state.sessionId = null;
      state.startedAt = null;
      state.currentSession = null;
    }

  function showTemporaryError(message) {
    const existing = document.getElementById("teachassist-ai-error");
    if (existing) existing.remove();
    const box = document.createElement("div");
    box.id = "teachassist-ai-error";
    box.style.cssText = "position:fixed;right:18px;top:18px;z-index:2147483647;background:#243B35;color:#FCFBF7;border:1px solid rgba(255,255,255,.15);border-radius:14px;padding:12px 14px;max-width:340px;box-shadow:0 14px 35px rgba(0,0,0,.28);font-family:Inter,Arial,sans-serif;font-size:13px;line-height:1.35;";
    box.textContent = message;
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 7000);
  }

  function showLessonReadyToast(message) {
    const existing = document.getElementById("teachassist-ai-ready-toast");
    if (existing) existing.remove();
    const box = document.createElement("div");
    box.id = "teachassist-ai-ready-toast";
    box.style.cssText = "position:fixed;right:18px;top:18px;z-index:2147483647;background:#3B9F68;color:#FCFBF7;border:1px solid rgba(255,255,255,.15);border-radius:14px;padding:12px 14px;max-width:340px;box-shadow:0 14px 35px rgba(0,0,0,.28);font-family:Inter,Arial,sans-serif;font-size:13px;line-height:1.35;";
    box.textContent = message;
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 6000);
  }

  function getMeetingTitle() {
    if (platform === "Google Meet") {
      const codeFromUrl = (location.pathname || "").split("/").filter(Boolean)[0];
      const title = cleanMeetingTitle(document.title || "");
      if (title && !/^google meet$/i.test(title)) return title;
      if (codeFromUrl) return `Meet - ${codeFromUrl}`;
      return "Google Meet";
    }

    if (platform === "Microsoft Teams") {
      const title = cleanMeetingTitle(document.title || "");
      if (title && !/microsoft teams/i.test(title)) return title;
      const ariaTitle = Array.from(document.querySelectorAll('[aria-label], [title]'))
        .map((el) => el.getAttribute('aria-label') || el.getAttribute('title') || '')
        .find((value) => value && /meeting|call|class/i.test(value));
      return cleanMeetingTitle(ariaTitle || "Microsoft Teams");
    }

    return cleanMeetingTitle(document.title || platform || "Meeting");
  }

  function cleanMeetingTitle(raw) {
    return String(raw || "")
      .replace(/\s+-\s+Google Meet$/i, "")
      .replace(/\s+\|\s+Microsoft Teams$/i, "")
      .replace(/^Google Meet\s+-\s*/i, "Meet - ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /*
   * Ported from the working class-recorder (v0.5.7) background.js's
   * extractStudentName(). That recorder derives the student name by
   * parsing the Meet/Teams tab title (set from the Calendar event
   * title), not by reading a live participant list — there is no
   * such DOM reading in the source implementation, so none is added
   * here. The "amanda" exclusion (the teacher's own name) is kept
   * as-is; TEACHER_NAME_EXCLUSIONS can be extended if needed.
   */
  const TEACHER_NAME_EXCLUSIONS = ["amanda"];

  const GENERIC_TITLES = [
    "google meet",
    "meet",
    "microsoft teams",
    "teams",
    "meeting",
    "untitled class",
    ""
  ];

  function looksLikeTeacherName(text) {
    const lower = String(text || "").trim().toLowerCase();
    return TEACHER_NAME_EXCLUSIONS.some((name) => lower.includes(name));
  }

  // A bare Google Meet room code, e.g. "gcx-enhi-nxz" (no spaces
  // around the hyphens — unlike a real "Name - Type" calendar
  // title, which always has spaces around the separating dash).
  function looksLikeMeetCode(text) {
    return /^[a-z]{2,4}-[a-z]{2,4}-[a-z]{2,4}$/i.test(String(text || "").trim());
  }

  // A bare date-like fragment (e.g. "08/01/2026", "2026-08-01"),
  // which should never be mistaken for a name or class type.
  function looksLikeDate(text) {
    return /^\d{1,4}[\/\-.]\d{1,2}([\/\-.]\d{1,4})?$/.test(String(text || "").trim());
  }

  function isUsableFragment(text) {
    const trimmed = String(text || "").trim();
    if (trimmed.length < 2) return false;
    if (!/[a-z]/i.test(trimmed)) return false;
    if (looksLikeDate(trimmed)) return false;
    if (looksLikeMeetCode(trimmed)) return false;
    if (GENERIC_TITLES.includes(trimmed.toLowerCase())) return false;
    return true;
  }

  /*
   * Parses a cleaned meeting title into { studentName, classType }.
   * Supports the two general calendar-title conventions requested:
   *   "Student Name - Class Type"   (e.g. "Luenia Oliveira - BeSpoke English Class")
   *   "Class Type (Student Name)"   (e.g. "AmeriClass (Marilda Amarante)")
   * No fixed list of class types is used — whatever text occupies
   * the "type" position is preserved as-is. Neither field is
   * invented when the title doesn't clearly match one of these
   * shapes; both are left null and the caller falls back to the
   * original meetingTitle for display.
   */
  function parseLessonTitle(meetingTitle) {
    const title = String(meetingTitle || "").trim();
    const empty = { studentName: null, classType: null };

    if (!title || GENERIC_TITLES.includes(title.toLowerCase())) return empty;
    if (looksLikeMeetCode(title)) return empty;
    // TeachAssist's own "Meet - <room-code>" fallback title.
    if (/^meet\s*-\s*[a-z]{2,4}-[a-z]{2,4}-[a-z]{2,4}$/i.test(title)) return empty;

    // Pattern: "Class Type (Student Name)"
    const parensMatch = title.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (parensMatch) {
      const classTypeCandidate = parensMatch[1].trim();
      const nameCandidate = parensMatch[2].trim();

      if (
        isUsableFragment(nameCandidate) &&
        !looksLikeTeacherName(nameCandidate)
      ) {
        return {
          studentName: nameCandidate,
          classType: isUsableFragment(classTypeCandidate) ? classTypeCandidate : null
        };
      }
    }

    // Pattern: "Student Name - Class Type" (spaced hyphen only, so
    // tightly-packed Meet room codes like "gcx-enhi-nxz" never
    // match here).
    const dashMatch = title.match(/^(.+?)\s+-\s+(.+)$/);
    if (dashMatch) {
      const nameCandidate = dashMatch[1].trim();
      const classTypeCandidate = dashMatch[2].trim();

      if (
        isUsableFragment(nameCandidate) &&
        isUsableFragment(classTypeCandidate) &&
        !looksLikeTeacherName(nameCandidate)
      ) {
        return { studentName: nameCandidate, classType: classTypeCandidate };
      }
    }

    // Legacy convention: "Aula de inglês (c/ Amanda) | Mint Communica"
    // — kept only for backward compatibility with older calendar
    // titles; does not attempt to detect a class type.
    const pipeMatch = title.match(/^(.+?)\s*\|\s*(.+)$/);
    if (pipeMatch) {
      const afterPipe = pipeMatch[2].trim();
      if (isUsableFragment(afterPipe) && !looksLikeTeacherName(afterPipe)) {
        return { studentName: afterPipe, classType: null };
      }
    }

    return empty;
  }

  function createSessionMetadata(startDate) {
    const sessionId = state.sessionId || crypto.randomUUID();
    const startedAt = startDate.toISOString();
    const meetingTitle = getMeetingTitle();
    const group = ensureMeetingGroup(startDate, meetingTitle);
    state.sessionCountInGroup += 1;
    const sessionNumber = state.sessionCountInGroup;
    const sessionFolderName = `session_${String(sessionNumber).padStart(3, "0")}`;

    if (!group.sessions.includes(sessionFolderName)) {
      group.sessions.push(sessionFolderName);
    }
    group.updatedAt = startedAt;

    const parsedTitle = parseLessonTitle(meetingTitle);

    const lessonJson = {
      sessionId,
      groupId: group.groupId,
      groupFolderName: group.folderName,
      sessionFolderName,
      sessionNumber,
      lessonTitle: meetingTitle || platform,
      displayName: parsedTitle.studentName,
      classType: parsedTitle.classType,
      meetingTitle: meetingTitle || platform,
      meetingPlatform: platform,
      startedAt,
      stoppedAt: null,
      createdAt: startedAt,
      durationSeconds: 0,
      recordingFilename: "lesson.webm"
    };

    const statusJson = {
      state: "recording",
      currentStep: "Recording",
      lastUpdated: startedAt,
      retryCount: 0,
      errors: []
    };

    return {
      sessionId,
      groupId: group.groupId,
      groupFolderName: group.folderName,
      sessionFolderName,
      groupJson: { ...group, sessions: [...group.sessions] },
      lessonJson,
      statusJson
    };
  }

  function ensureMeetingGroup(startDate, meetingTitle) {
    if (state.currentGroup) return state.currentGroup;

    const groupId = crypto.randomUUID();
    const folderName = makeGroupFolderName(startDate, platform, meetingTitle || platform);
    state.currentGroup = {
      groupId,
      folderName,
      meetingTitle: meetingTitle || platform,
      meetingPlatform: platform,
      createdAt: startDate.toISOString(),
      updatedAt: startDate.toISOString(),
      sessions: [],
      mergeStatus: "not_decided"
    };
    state.sessionCountInGroup = 0;
    return state.currentGroup;
  }

  function meetingTitleSegment(title) {
    const cleaned = String(title || "meeting")
      .replace(/^Meet\s*-\s*/i, "")
      .replace(/^Google\s*Meet\s*-\s*/i, "")
      .replace(/^Microsoft\s*Teams\s*-\s*/i, "")
      .trim();
    return cleaned || title || "meeting";
  }

  function safeFolderSegment(value = "") {
    return String(value)
      .replace(/[^a-z0-9_\-\.]+/gi, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "meeting";
  }

  function makeGroupFolderName(date, meetingPlatform, meetingTitle) {
    const datePart = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}_${String(date.getHours()).padStart(2,"0")}-${String(date.getMinutes()).padStart(2,"0")}`;
    const platformPart = meetingPlatform.replace(/[^a-z0-9]+/gi, "");
    const titlePart = safeFolderSegment(meetingTitleSegment(meetingTitle));
    return `${datePart}_${platformPart}_${titlePart}`;
  }

  function formatDateForLessonName(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")} ${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
  }

  async function getPendingLessonsCount() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "TA_GET_PENDING_COUNT" });
      return response?.pendingLessons || 0;
    } catch (_) {
      return 0;
    }
  }

  function formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function wireMessages() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (
        message?.type === "TA_DELETE_LESSON" ||
        message?.type === "TA_RETRY_TRANSCRIPTION" ||
        message?.type === "TA_UPDATE_LESSON_STUDENT_NAME" ||
        message?.type === "TA_GET_DASHBOARD_SNAPSHOT" ||
        message?.type === "TA_START_AI_STAGE" ||
        message?.type === "TA_SAVE_AI_ARTIFACT_RESULT" ||
        message?.type === "TA_FAIL_AI_STAGE"
      ) {
        return false;
      }

      (async () => {
        if (message?.type === "TA_PING") {
          sendResponse({ ok: true });
          return;
        }
        if (message?.type === "TA_TOGGLE_RECORDING") {
          const result = await toggleRecording();
          sendResponse({ ok: Boolean(result?.ok), isRecording: state.isRecording, sessionId: state.sessionId, reason: result?.reason || null });
          return;
        }
        if (message?.type === "TA_GET_STATE") {
          updateActiveMeetingUi();
          sendResponse({
            ok: true,
            isMeeting: state.activeMeeting,
            platform: state.activeMeeting ? platform : null,
            isRecording: state.isRecording,
            sessionId: state.sessionId,
            elapsedSeconds: state.elapsedSeconds,
            pendingLessons: await getPendingLessonsCount(),
            microphone: state.activeMeeting ? "Working" : null,
            storage: state.activeMeeting ? "Healthy" : null
          });
          return;
        }
        if (message?.type === "TA_LESSON_READY") {
          const name = message.studentName;
          showLessonReadyToast(
            name
              ? `Lesson ready — ${name} has finished processing.`
              : "Lesson ready — processing is complete."
          );
          sendResponse({ ok: true });
          return;
        }
        sendResponse({ ok: false, reason: "UNKNOWN_MESSAGE" });
      })();
      return true;
    });
  }
})();