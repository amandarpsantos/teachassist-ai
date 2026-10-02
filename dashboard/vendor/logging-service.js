/**
 * TeachAssist AI — Logging Service
 *
 * Owns all permanent application logs.
 *
 * Other services must use LoggingService instead of calling
 * TeachAssistDB.appendLog() or TeachAssistDB.getLogs() directly.
 */

const LoggingService = (() => {
  const VALID_SEVERITIES = new Set([
    "debug",
    "info",
    "warning",
    "error"
  ]);

  /**
   * Saves a structured log entry.
   */
  async function write(input = {}) {
    validateLogInput(input);

    const logEntry = {
      lessonId: input.lessonId || null,
      sessionId: input.sessionId || null,
      segmentId: input.segmentId || null,

      stage: input.stage || "application",
      severity: input.severity || "info",
      code: input.code || "GENERAL_LOG",

      message: input.message.trim(),

      technicalDetails:
        input.technicalDetails || null,

      metadata: sanitizeMetadata(
        input.metadata || {}
      ),

      occurredAt:
        input.occurredAt ||
        new Date().toISOString()
    };

    return TeachAssistDB.appendLog(logEntry);
  }

  async function debug(input = {}) {
    return write({
      ...input,
      severity: "debug"
    });
  }

  async function info(input = {}) {
    return write({
      ...input,
      severity: "info"
    });
  }

  async function warning(input = {}) {
    return write({
      ...input,
      severity: "warning"
    });
  }

  async function error(input = {}) {
    return write({
      ...input,
      severity: "error"
    });
  }

  /**
   * Saves a structured application error.
   */
  async function recordError(input = {}) {
    if (
      typeof input.code !== "string" ||
      !input.code.trim()
    ) {
      throw new TypeError(
        "An error code is required."
      );
    }

    if (
      typeof input.userMessage !== "string" ||
      !input.userMessage.trim()
    ) {
      throw new TypeError(
        "A userMessage is required."
      );
    }

    const occurredAt =
      input.occurredAt ||
      new Date().toISOString();

    const structuredError = {
      errorId:
        input.errorId ||
        crypto.randomUUID(),

      lessonId: input.lessonId || null,
      sessionId: input.sessionId || null,
      segmentId: input.segmentId || null,

      code: input.code.trim(),
      category:
        input.category || "application",
      stage:
        input.stage || "application",

      userMessage:
        input.userMessage.trim(),

      technicalMessage:
        input.technicalMessage || null,

      recoverable:
        typeof input.recoverable === "boolean"
          ? input.recoverable
          : false,

      suggestedAction:
        input.suggestedAction || null,

      attempt:
        Number.isInteger(input.attempt)
          ? input.attempt
          : null,

      provider:
        input.provider || null,

      occurredAt,

      metadata: sanitizeMetadata(
        input.metadata || {}
      )
    };

    await write({
      lessonId: structuredError.lessonId,
      sessionId: structuredError.sessionId,
      segmentId: structuredError.segmentId,

      stage: structuredError.stage,
      severity: "error",
      code: structuredError.code,

      message:
        structuredError.userMessage,

      technicalDetails:
        structuredError.technicalMessage,

      occurredAt,

      metadata: {
        errorId: structuredError.errorId,
        category: structuredError.category,
        recoverable:
          structuredError.recoverable,
        suggestedAction:
          structuredError.suggestedAction,
        attempt:
          structuredError.attempt,
        provider:
          structuredError.provider,
        ...structuredError.metadata
      }
    });

    return structuredError;
  }

  async function getLessonLogs(lessonId) {
    requireNonEmptyString(
      lessonId,
      "lessonId"
    );

    return TeachAssistDB.getLogs(lessonId);
  }

  function validateLogInput(input) {
    if (
      typeof input.message !== "string" ||
      !input.message.trim()
    ) {
      throw new TypeError(
        "A log message is required."
      );
    }

    const severity =
      input.severity || "info";

    if (!VALID_SEVERITIES.has(severity)) {
      throw new Error(
        `Invalid log severity: ${severity}`
      );
    }

    if (
      input.occurredAt !== undefined &&
      Number.isNaN(
        Date.parse(input.occurredAt)
      )
    ) {
      throw new Error(
        "occurredAt must be a valid date."
      );
    }
  }

  /**
   * Prevents sensitive information from accidentally
   * being written into permanent logs.
   */
  function sanitizeMetadata(metadata) {
    if (
      !metadata ||
      typeof metadata !== "object"
    ) {
      return {};
    }

    const sanitized = {
      ...metadata
    };

    const sensitiveKeys = [
      "apiKey",
      "api_key",
      "authorization",
      "token",
      "accessToken",
      "refreshToken",
      "password",
      "secret"
    ];

    for (const key of sensitiveKeys) {
      if (
        Object.prototype.hasOwnProperty.call(
          sanitized,
          key
        )
      ) {
        sanitized[key] = "[REDACTED]";
      }
    }

    return sanitized;
  }

  function requireNonEmptyString(
    value,
    fieldName
  ) {
    if (
      typeof value !== "string" ||
      !value.trim()
    ) {
      throw new TypeError(
        `${fieldName} must be a non-empty string.`
      );
    }
  }

  return Object.freeze({
    write,
    debug,
    info,
    warning,
    error,
    recordError,
    getLessonLogs
  });
})();

// Phase 2.6: see the matching comment in artifact-service.js — same
// fix for LoggingService (read via window.LoggingService by
// ExtensionDataAdapter.uploadRecoveredRecording()).
globalThis.LoggingService = LoggingService;
