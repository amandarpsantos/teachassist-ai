/**
 * TeachAssist AI — Recorder Service
 *
 * Owns communication with the offscreen audio recorder.
 *
 * Responsibilities:
 * - request a tab-audio stream ID
 * - start the offscreen recorder
 * - report tab-audio availability
 *
 * It does not own:
 * - lesson records
 * - recording-session state
 * - pipeline state
 * - transcript or summary generation
 */

const RecorderService = (() => {
  const OFFSCREEN_START_MESSAGE =
    "TA_OFFSCREEN_START_RECORDING";

  /**
   * Safely requests a Chrome tab-capture stream ID.
   */
  async function tryGetStreamId(
    constraints,
    label
  ) {
    try {
      const streamId =
        await chrome.tabCapture.getMediaStreamId(
          constraints
        );

      if (streamId) {
        return {
          ok: true,
          streamId,
          label
        };
      }

      return {
        ok: false,
        label,
        error:
          "No stream ID returned."
      };
    } catch (error) {
      return {
        ok: false,
        label,
        error:
          error instanceof Error
            ? error.message
            : String(error),
        lastError:
          chrome.runtime.lastError
            ?.message || ""
      };
    }
  }

  /**
   * Attempts to obtain tab audio.
   *
   * First uses targetTabId.
   * Then falls back to the active tab for Chrome
   * builds that require a popup click or command.
   */
  async function getTabAudioStreamId(
    tabId
  ) {
    if (!Number.isInteger(tabId)) {
      throw new Error(
        "RecorderService.getTabAudioStreamId requires a valid tabId."
      );
    }

    const attempts = [];

    attempts.push(
      await tryGetStreamId(
        {
          targetTabId: tabId
        },
        "targetTabId"
      )
    );

    if (!attempts[0].ok) {
      attempts.push(
        await tryGetStreamId(
          {},
          "activeTabFallback"
        )
      );
    }

    const successfulAttempt =
      attempts.find(
        attempt =>
          attempt.ok &&
          attempt.streamId
      );

    if (successfulAttempt) {
      return {
        ok: true,
        streamId:
          successfulAttempt.streamId,
        source:
          successfulAttempt.label,
        attempts
      };
    }

    const error =
      attempts
        .map(attempt => {
          const detail =
            attempt.lastError ||
            attempt.error ||
            "failed";

          return `${attempt.label}: ${detail}`;
        })
        .join(" | ");

    return {
      ok: false,
      streamId: null,
      source: null,
      error,
      attempts
    };
  }

  /**
   * Starts the offscreen recorder.
   */
  async function startRecording({
    tabId,
    sessionId,
    lessonId = null,
    mode = "mixed",
    mimeType =
      "audio/webm;codecs=opus"
  } = {}) {
    if (!Number.isInteger(tabId)) {
      return {
        ok: false,
        reason: "NO_TAB_ID"
      };
    }

    if (!sessionId) {
      return {
        ok: false,
        reason: "NO_SESSION_ID"
      };
    }

    let streamId = null;
    let tabAudioAvailable = true;
    let tabAudioError = null;

    const streamResult =
      await getTabAudioStreamId(tabId);

    if (streamResult.ok) {
      streamId =
        streamResult.streamId;
    } else {
      tabAudioAvailable = false;
      tabAudioError =
        streamResult.error ||
        "Tab audio unavailable.";

      console.warn(
          "TeachAssist tab audio stream ID failed:",
          JSON.stringify(streamResult, null, 2)
        );
    }

    if (
      mode === "tab-only" &&
      !streamId
    ) {
      return {
        ok: false,
        reason:
          "TAB_AUDIO_STREAM_ID_FAILED",
        error:
          tabAudioError ||
          "No tab audio stream ID returned.",
        hint:
          "Start recording from the extension popup or assigned Chrome shortcut while keeping the meeting tab active."
      };
    }

    try {
      const response =
        await chrome.runtime.sendMessage({
          type:
            OFFSCREEN_START_MESSAGE,
          streamId,
          sessionId,
          lessonId,
          mimeType,
          mode,
          tabAudioAvailable,
          tabAudioError
        });

      return (
        response || {
          ok: false,
          reason:
            "NO_OFFSCREEN_RESPONSE"
        }
      );
    } catch (error) {
      return {
        ok: false,
        reason:
          "OFFSCREEN_START_FAILED",
        error:
          error instanceof Error
            ? error.message
            : String(error)
      };
    }
  }

    /**
 * Stops the offscreen recorder.
 */
async function stopRecording(sessionId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TA_OFFSCREEN_STOP_RECORDING",
      sessionId
    });

    return (
      response || {
        ok: false,
        reason: "NO_OFFSCREEN_RESPONSE"
      }
    );
  } catch (error) {
    return {
      ok: false,
      reason: "OFFSCREEN_STOP_FAILED",
      error:
        error instanceof Error
          ? error.message
          : String(error)
    };
  }
}

  return Object.freeze({
      getTabAudioStreamId,
      startRecording,
      stopRecording
    });
})();