/**
 * TeachAssist AI — Lesson Service
 *
 * Manages the lifecycle and permanent metadata of a lesson.
 *
 * This service understands lesson rules, but it does not know how
 * IndexedDB works. Permanent lesson storage is handled by TeachAssistDB.
 *
 * Permanent logs must be written through LoggingService.
 */

const LessonService = (() => {
  const VALID_RECORDING_STATUSES = new Set([
    "pending",
    "recording",
    "saving",
    "completed",
    "completed_with_warning",
    "failed"
  ]);

  /**
   * Creates a new lesson when recording begins.
   *
   * Returns the permanent lessonId that must be used for all
   * audio files, logs, pipeline stages, and later processing.
   */
  async function startLesson(input = {}) {
    validateStartInput(input);

    const startedAt =
      input.startedAt || new Date().toISOString();

    const result = await TeachAssistDB.createLesson({
      studentId: input.studentId || null,
      studentName:
        input.studentName || "Unknown Student",

      classTitle:
        input.classTitle || "English Class",
      classProgram:
        input.classProgram || null,

      platform:
        input.platform || null,
      meetingUrl:
        input.meetingUrl || null,

      startedAt,
      stoppedAt: null,
      recorderMeasuredDurationMs: null,
      recordingStatus: "recording"
    });

    const lesson = result.lesson;

    /*
     * Temporary direct database call.
     *
     * This will move to PipelineService once that
     * service has been created.
     */
    await TeachAssistDB.updatePipelineStage(
      lesson.lessonId,
      "recording",
      {
        status: "running",
        attempts: 1,
        startedAt,
        finishedAt: null,
        error: null
      }
    );

    await LoggingService.info({
      lessonId: lesson.lessonId,
      stage: "recording",
      code: "LESSON_STARTED",
      message: "Lesson recording started.",
      metadata: {
        platform: lesson.class.platform,
        studentName: lesson.student.name
      }
    });

    return {
      lessonId: lesson.lessonId,
      lesson
    };
  }

  /**
   * Marks the lesson as saving after MediaRecorder has stopped.
   *
   * At this stage, the lesson is not yet safely recorded because
   * the original audio artifacts still need to be stored.
   */
  async function markLessonSaving(
    lessonId,
    input = {}
  ) {
    requireLessonId(lessonId);

    const lesson =
      await requireLesson(lessonId);

    const stoppedAt =
      input.stoppedAt ||
      new Date().toISOString();

    const durationMs = calculateDurationMs({
      startedAt:
        lesson.recording.startedAt,
      stoppedAt,
      suppliedDurationMs:
        input.recorderMeasuredDurationMs
    });

    const updatedLesson =
      await TeachAssistDB.updateLesson(
        lessonId,
        {
          recording: {
            status: "saving",
            stoppedAt,
            recorderMeasuredDurationMs:
              durationMs
          },
          overallStatus: "pending"
        }
      );

    await LoggingService.info({
      lessonId,
      stage: "recording",
      code: "RECORDING_STOPPED",
      message:
        "Recording stopped. TeachAssist is saving the original audio tracks.",
      metadata: {
        stoppedAt,
        recorderMeasuredDurationMs:
          durationMs
      }
    });

    return updatedLesson;
  }

  /**
   * Updates the stored condition of one original audio track.
   *
   * trackName must be:
   * - microphone
   * - meeting
   */
  async function updateRecordingTrack(
    lessonId,
    trackName,
    input = {}
  ) {
    requireLessonId(lessonId);
    requireTrackName(trackName);

    await requireLesson(lessonId);

    const status =
      input.status || "saved";

    const validStatuses = new Set([
      "pending",
      "saving",
      "saved",
      "unavailable",
      "blank",
      "failed"
    ]);

    if (!validStatuses.has(status)) {
      throw new Error(
        `Invalid recording track status: ${status}`
      );
    }

    const trackUpdate = {
      artifactId:
        input.artifactId || null,

      filename:
        input.filename ||
        (
          trackName === "microphone"
            ? "microphone.webm"
            : "tab_audio.webm"
        ),

      mimeType:
        input.mimeType || "audio/webm",

      sizeBytes:
        Number.isFinite(input.sizeBytes)
          ? input.sizeBytes
          : null,

      status,

      error:
        normalizeTrackError(input.error)
    };

    const updatedLesson =
      await TeachAssistDB.updateLesson(
        lessonId,
        {
          recording: {
            tracks: {
              [trackName]: trackUpdate
            }
          }
        }
      );

    const severity =
      status === "saved"
        ? "info"
        : status === "unavailable" ||
            status === "blank"
          ? "warning"
          : "error";

    await LoggingService.write({
      lessonId,
      stage: "recording",
      severity,

      code:
        status === "saved"
          ? "AUDIO_TRACK_SAVED"
          : "AUDIO_TRACK_PROBLEM",

      message:
        status === "saved"
          ? `${getTrackLabel(
              trackName
            )} audio was saved.`
          : `${getTrackLabel(
              trackName
            )} audio could not be saved normally.`,

      technicalDetails:
        trackUpdate.error
          ?.technicalMessage || null,

      metadata: {
        trackName,
        status,
        filename:
          trackUpdate.filename,
        sizeBytes:
          trackUpdate.sizeBytes,
        error:
          trackUpdate.error
      }
    });

    return updatedLesson;
  }

  /**
   * Finalizes the recording stage after all available original
   * audio tracks have been saved or explicitly marked unavailable.
   *
   * This function never discards one valid track merely because
   * the other track failed.
   */
  async function finalizeRecording(
    lessonId
  ) {
    requireLessonId(lessonId);

    const lesson =
      await requireLesson(lessonId);

    const microphone =
      lesson.recording.tracks.microphone;

    const meeting =
      lesson.recording.tracks.meeting;

    const microphoneSaved =
      microphone?.status === "saved" &&
      Number(microphone?.sizeBytes) > 0;

    const meetingSaved =
      meeting?.status === "saved" &&
      Number(meeting?.sizeBytes) > 0;

    if (
      !microphoneSaved &&
      !meetingSaved
    ) {
      const error = {
        code: "NO_VALID_AUDIO_TRACKS",
        category: "recording",

        message:
          "Neither microphone audio nor meeting audio was saved.",

        technicalMessage:
          "Both original audio tracks were missing, blank, or invalid.",

        recoverable: false,

        suggestedAction:
          "inspect_recording"
      };

      const now =
        new Date().toISOString();

      await TeachAssistDB.updateLesson(
        lessonId,
        {
          recording: {
            status: "failed"
          },
          overallStatus: "failed"
        }
      );

      /*
       * Temporary direct database call.
       *
       * This will move to PipelineService once that
       * service has been created.
       */
      await TeachAssistDB.updatePipelineStage(
        lessonId,
        "recording",
        {
          status: "failed",
          finishedAt: now,
          error
        }
      );

      await LoggingService.recordError({
        lessonId,
        stage: "recording",
        category: error.category,
        code: error.code,

        userMessage:
          error.message,

        technicalMessage:
          error.technicalMessage,

        recoverable:
          error.recoverable,

        suggestedAction:
          error.suggestedAction,

        occurredAt: now
      });

      throw new Error(error.message);
    }

    const hasWarning =
      !microphoneSaved ||
      !meetingSaved;

    const recordingStatus =
      hasWarning
        ? "completed_with_warning"
        : "completed";

    const now =
      new Date().toISOString();

    const updatedLesson =
      await TeachAssistDB.updateLesson(
        lessonId,
        {
          recording: {
            status: recordingStatus
          },
          overallStatus: "pending"
        }
      );

    /*
     * Temporary direct database calls.
     *
     * These will move to PipelineService once that
     * service has been created.
     */
    await TeachAssistDB.updatePipelineStage(
      lessonId,
      "recording",
      {
        status: "completed",
        finishedAt: now,
        error: null
      }
    );

    await TeachAssistDB.updatePipelineStage(
      lessonId,
      "inspection",
      {
        status: "pending"
      }
    );

    await LoggingService.write({
      lessonId,
      stage: "recording",

      severity:
        hasWarning
          ? "warning"
          : "info",

      code:
        hasWarning
          ? "RECORDING_COMPLETED_WITH_WARNING"
          : "RECORDING_COMPLETED",

      message:
        hasWarning
          ? "The lesson was saved with one available audio track."
          : "The lesson and both original audio tracks were saved safely.",

      metadata: {
        microphoneSaved,
        meetingSaved,
        recordingStatus
      }
    });

    return updatedLesson;
  }

  /**
   * Marks a recording-level failure while preserving any artifacts
   * that were already saved.
   */
  async function failRecording(
    lessonId,
    input = {}
  ) {
    requireLessonId(lessonId);

    await requireLesson(lessonId);

    const error = {
      code:
        input.code ||
        "RECORDING_FAILED",

      category:
        input.category ||
        "recording",

      message:
        input.message ||
        "The recording stage did not finish successfully.",

      technicalMessage:
        input.technicalMessage ||
        null,

      recoverable:
        typeof input.recoverable ===
        "boolean"
          ? input.recoverable
          : true,

      suggestedAction:
        input.suggestedAction ||
        "retry_or_recover"
    };

    const now =
      new Date().toISOString();

    const updatedLesson =
      await TeachAssistDB.updateLesson(
        lessonId,
        {
          recording: {
            status: "failed"
          },
          overallStatus: "failed"
        }
      );

    /*
     * Temporary direct database call.
     *
     * This will move to PipelineService once that
     * service has been created.
     */
    await TeachAssistDB.updatePipelineStage(
      lessonId,
      "recording",
      {
        status: "failed",
        finishedAt: now,
        error
      }
    );

    await LoggingService.recordError({
      lessonId,
      stage: "recording",
      category: error.category,
      code: error.code,

      userMessage:
        error.message,

      technicalMessage:
        error.technicalMessage,

      recoverable:
        error.recoverable,

      suggestedAction:
        error.suggestedAction,

      occurredAt: now
    });

    return updatedLesson;
  }

  /**
   * Returns a complete lesson view for diagnostics.
   *
   * Pipeline and artifact access remain direct temporarily because
   * PipelineService and ArtifactService do not exist yet.
   */
  async function getLessonDetails(
    lessonId
  ) {
    requireLessonId(lessonId);

    const lesson =
      await TeachAssistDB.getLesson(
        lessonId
      );

    if (!lesson) {
      return null;
    }

    const [
      pipeline,
      artifacts,
      logs
    ] = await Promise.all([
      TeachAssistDB.getPipelineState(
        lessonId
      ),

      TeachAssistDB.listArtifacts(
        lessonId
      ),

      LoggingService.getLessonLogs(
        lessonId
      )
    ]);

    return {
      lesson,
      pipeline,
      artifacts,
      logs
    };
  }

  async function getLesson(lessonId) {
    requireLessonId(lessonId);

    return TeachAssistDB.getLesson(
      lessonId
    );
  }

  async function listLessons(
    options = {}
  ) {
    return TeachAssistDB.listLessons(
      options
    );
  }

  /**
   * Updates editable lesson information without exposing raw
   * database operations to the rest of the application.
   */
  async function updateLessonInformation(
    lessonId,
    input = {}
  ) {
    requireLessonId(lessonId);

    await requireLesson(lessonId);

    const updates = {};

    if (
      input.studentId !== undefined ||
      input.studentName !== undefined
    ) {
      updates.student = {};

      if (
        input.studentId !== undefined
      ) {
        updates.student.studentId =
          input.studentId || null;
      }

      if (
        input.studentName !== undefined
      ) {
        updates.student.name =
          String(
            input.studentName
          ).trim() ||
          "Unknown Student";
      }
    }

    if (
      input.classTitle !== undefined ||
      input.classProgram !== undefined ||
      input.platform !== undefined ||
      input.meetingUrl !== undefined
    ) {
      updates.class = {};

      if (
        input.classTitle !== undefined
      ) {
        updates.class.title =
          String(
            input.classTitle
          ).trim() ||
          "English Class";
      }

      if (
        input.classProgram !== undefined
      ) {
        updates.class.program =
          input.classProgram || null;
      }

      if (
        input.platform !== undefined
      ) {
        updates.class.platform =
          input.platform || null;
      }

      if (
        input.meetingUrl !== undefined
      ) {
        updates.class.meetingUrl =
          input.meetingUrl || null;
      }
    }

    if (
      Object.keys(updates).length === 0
    ) {
      return requireLesson(lessonId);
    }

    const updatedLesson =
      await TeachAssistDB.updateLesson(
        lessonId,
        updates
      );

    await LoggingService.info({
      lessonId,
      stage: "lesson",
      code:
        "LESSON_INFORMATION_UPDATED",
      message:
        "Lesson information was updated."
    });

    return updatedLesson;
  }

  /**
   * Only allows supported recording statuses.
   */
  async function setRecordingStatus(
    lessonId,
    status
  ) {
    requireLessonId(lessonId);

    if (
      !VALID_RECORDING_STATUSES.has(
        status
      )
    ) {
      throw new Error(
        `Invalid recording status: ${status}`
      );
    }

    await requireLesson(lessonId);

    return TeachAssistDB.updateLesson(
      lessonId,
      {
        recording: {
          status
        }
      }
    );
  }

  async function requireLesson(
    lessonId
  ) {
    const lesson =
      await TeachAssistDB.getLesson(
        lessonId
      );

    if (!lesson) {
      throw new Error(
        `Lesson not found: ${lessonId}`
      );
    }

    return lesson;
  }

  function calculateDurationMs({
    startedAt,
    stoppedAt,
    suppliedDurationMs
  }) {
    if (
      Number.isFinite(
        suppliedDurationMs
      ) &&
      suppliedDurationMs >= 0
    ) {
      return Math.round(
        suppliedDurationMs
      );
    }

    const startTime =
      Date.parse(startedAt);

    const stopTime =
      Date.parse(stoppedAt);

    if (
      Number.isFinite(startTime) &&
      Number.isFinite(stopTime) &&
      stopTime >= startTime
    ) {
      return stopTime - startTime;
    }

    return null;
  }

  function normalizeTrackError(error) {
    if (!error) {
      return null;
    }

    if (
      typeof error === "string"
    ) {
      return {
        code: "AUDIO_TRACK_ERROR",
        message: error
      };
    }

    return {
      code:
        error.code ||
        "AUDIO_TRACK_ERROR",

      message:
        error.message ||
        "The audio track was unavailable.",

      technicalMessage:
        error.technicalMessage ||
        null,

      recoverable:
        typeof error.recoverable ===
        "boolean"
          ? error.recoverable
          : true
    };
  }

  function getTrackLabel(trackName) {
    return trackName === "microphone"
      ? "Microphone"
      : "Meeting";
  }

  function validateStartInput(input) {
    if (
      input.startedAt !== undefined &&
      Number.isNaN(
        Date.parse(input.startedAt)
      )
    ) {
      throw new Error(
        "startedAt must be a valid date."
      );
    }
  }

  function requireLessonId(lessonId) {
    if (
      typeof lessonId !== "string" ||
      !lessonId.trim()
    ) {
      throw new TypeError(
        "lessonId must be a non-empty string."
      );
    }
  }

  function requireTrackName(
    trackName
  ) {
    if (
      trackName !== "microphone" &&
      trackName !== "meeting"
    ) {
      throw new Error(
        'trackName must be "microphone" or "meeting".'
      );
    }
  }

  return Object.freeze({
    startLesson,
    markLessonSaving,
    updateRecordingTrack,
    finalizeRecording,
    failRecording,

    getLesson,
    getLessonDetails,
    listLessons,
    updateLessonInformation,
    setRecordingStatus
  });
})();