/**
 * TeachAssist AI — Recording Session Service
 *
 * Owns the state of the current live recording session.
 *
 * This first version does not yet:
 * - capture microphone audio
 * - capture meeting audio
 * - communicate with the offscreen recorder
 * - save audio artifacts
 * - start the transcription pipeline
 *
 * Those responsibilities will be connected gradually.
 */

const RecordingSessionService = (() => {
  const STORAGE_KEY =
    "teachAssistGlobalState";

  const SESSION_STATUS =
    Object.freeze({
      IDLE: "idle",
      STARTING: "starting",
      RECORDING: "recording",
      STOPPING: "stopping",
      STOPPED: "stopped",
      NEEDS_ATTENTION: "needs_attention",
      ERROR: "error"
    });

  /**
   * Creates a complete empty session state.
   */
  function createDefaultState() {
    return {
      status:
        SESSION_STATUS.IDLE,

      isRecording: false,

      activeSessionId: null,
      activeLessonId: null,
      activeTabId: null,

      meeting: null,

      startedAt: null,
      stoppedAt: null,
      stopReason: null,

      lastError: null,
      lastUpdated:
        new Date().toISOString()
    };
  }

  /**
   * Makes sure older saved state objects contain
   * all fields expected by the current service.
   */
  function normalizeState(
    savedState = {}
  ) {
    const defaultState =
      createDefaultState();

    const isRecording =
      Boolean(savedState?.isRecording);

    let status =
      savedState?.status;

    if (
      !Object.values(
        SESSION_STATUS
      ).includes(status)
    ) {
      status = isRecording
        ? SESSION_STATUS.RECORDING
        : SESSION_STATUS.IDLE;
    }

    return {
      ...defaultState,
      ...savedState,

      status,
      isRecording,

      activeSessionId:
        savedState?.activeSessionId ||
        null,

      activeLessonId:
        savedState?.activeLessonId ||
        null,

      activeTabId:
        Number.isInteger(
          savedState?.activeTabId
        )
          ? savedState.activeTabId
          : null,

      meeting:
        savedState?.meeting &&
        typeof savedState.meeting ===
          "object"
          ? savedState.meeting
          : null,

      lastUpdated:
        savedState?.lastUpdated ||
        defaultState.lastUpdated
    };
  }

  /**
   * Loads and normalizes the saved state.
   */
  async function initialize() {
    const stored =
      await chrome.storage.local.get([
        STORAGE_KEY
      ]);

    const state =
      normalizeState(
        stored[STORAGE_KEY]
      );

    await saveState(state);

    return state;
  }

  /**
   * Returns the current session state.
   */
  async function getState() {
    const stored =
      await chrome.storage.local.get([
        STORAGE_KEY
      ]);

    return normalizeState(
      stored[STORAGE_KEY]
    );
  }

  /**
   * Saves the complete session state.
   *
   * Other services should use the public state
   * transition methods instead of calling this
   * directly.
   */
  async function saveState(state) {
    const normalized =
      normalizeState({
        ...state,
        lastUpdated:
          new Date().toISOString()
      });

    await chrome.storage.local.set({
      [STORAGE_KEY]: normalized
    });

    return normalized;
  }

  /**
   * Updates selected properties while preserving
   * the rest of the current session state.
   */
  async function updateState(
    changes = {}
  ) {
    const current =
      await getState();

    return saveState({
      ...current,
      ...changes
    });
  }

  /**
   * Marks that a new recording is preparing to start.
   */
  async function beginStarting({
    sessionId,
    lessonId = null,
    tabId,
    meeting = null
  } = {}) {
    if (!sessionId) {
      throw new Error(
        "RecordingSessionService.beginStarting requires sessionId."
      );
    }

    if (!Number.isInteger(tabId)) {
      throw new Error(
        "RecordingSessionService.beginStarting requires a valid tabId."
      );
    }

    const current =
      await getState();

    if (
      current.isRecording ||
      current.status ===
        SESSION_STATUS.STARTING ||
      current.status ===
        SESSION_STATUS.STOPPING
    ) {
      throw new Error(
        "A recording session is already active."
      );
    }

    return saveState({
      ...createDefaultState(),

      status:
        SESSION_STATUS.STARTING,

      activeSessionId:
        sessionId,

      activeLessonId:
        lessonId,

      activeTabId:
        tabId,

      meeting:
        meeting &&
        typeof meeting === "object"
          ? meeting
          : null
    });
  }

  /**
   * Marks that audio recording has successfully begun.
   */
  async function markRecording({
    startedAt = null
  } = {}) {
    const current =
      await getState();

    if (!current.activeSessionId) {
      throw new Error(
        "Cannot mark recording active without an active session."
      );
    }

    return saveState({
      ...current,

      status:
        SESSION_STATUS.RECORDING,

      isRecording: true,

      startedAt:
        startedAt ||
        current.startedAt ||
        new Date().toISOString(),

      stoppedAt: null,
      stopReason: null,
      lastError: null
    });
  }

  /**
   * Marks that the recording is being stopped.
   */
  async function beginStopping({
    reason = "user_stopped"
  } = {}) {
    const current =
      await getState();

    if (!current.activeSessionId) {
      throw new Error(
        "There is no active recording session to stop."
      );
    }

    return saveState({
      ...current,

      status:
        SESSION_STATUS.STOPPING,

      stopReason:
        reason || "user_stopped"
    });
  }

  /**
   * Marks that recording stopped successfully.
   */
  async function markStopped({
    stoppedAt = null,
    reason = null
  } = {}) {
    const current =
      await getState();

    return saveState({
      ...current,

      status:
        SESSION_STATUS.STOPPED,

      isRecording: false,

      stoppedAt:
        stoppedAt ||
        new Date().toISOString(),

      stopReason:
        reason ||
        current.stopReason ||
        "user_stopped",

      lastError: null
    });
  }

  /**
   * Marks a recording that ended unexpectedly and
   * may need recovery or user review.
   */
  async function markNeedsAttention(
    reason
  ) {
    const current =
      await getState();

    return saveState({
      ...current,

      status:
        SESSION_STATUS.NEEDS_ATTENTION,

      isRecording: false,

      stoppedAt:
        current.stoppedAt ||
        new Date().toISOString(),

      stopReason:
        reason ||
        "recording_interrupted",

      lastError:
        reason ||
        "Recording interrupted."
    });
  }

  /**
   * Marks a recording-session error.
   */
  async function markError(error) {
    const current =
      await getState();

    const message =
      error instanceof Error
        ? error.message
        : String(
            error ||
            "Unknown recording-session error"
          );

    return saveState({
      ...current,

      status:
        SESSION_STATUS.ERROR,

      isRecording: false,

      lastError: message
    });
  }

  /**
   * Clears the live session after its lesson and
   * recording data have been safely preserved.
   */
  async function reset() {
    return saveState(
      createDefaultState()
    );
  }

  /**
   * Returns true when a session is starting,
   * recording, or stopping.
   */
  async function hasActiveSession() {
    const state =
      await getState();

    return Boolean(
      state.activeSessionId &&
      [
        SESSION_STATUS.STARTING,
        SESSION_STATUS.RECORDING,
        SESSION_STATUS.STOPPING
      ].includes(state.status)
    );
  }

/**
 * Begins a new recording session and delegates the
 * actual audio startup to the supplied recorder callback.
 *
 * RecordingSessionService owns the session lifecycle.
 * The callback still owns the existing recorder code.
 */
async function startRecordingSession({
  sessionId,
  lessonId = null,
  tabId,
  meeting = null,
  startRecorder
} = {}) {
  if (typeof startRecorder !== "function") {
    throw new Error(
      "RecordingSessionService.startRecordingSession requires a startRecorder callback."
    );
  }

  await beginStarting({
    sessionId,
    lessonId,
    tabId,
    meeting
  });

  try {
    const recorderResult =
      await startRecorder();

    /*
     * Do not call markRecording() here yet.
     *
     * The existing recorder will continue reporting
     * TA_RECORDING_STATE_CHANGED after audio capture
     * has genuinely started.
     */
    return {
      ok: true,
      sessionId,
      lessonId,
      tabId,
      recorderResult
    };
  } catch (error) {
    await markError(error);

    throw error;
  }
}
    
  return Object.freeze({
      SESSION_STATUS,
    
      initialize,
      getState,
      startRecordingSession,
    
      beginStarting,
      markRecording,
      beginStopping,
      markStopped,
      markNeedsAttention,
      markError,
      reset,
    
      hasActiveSession
    });
})();