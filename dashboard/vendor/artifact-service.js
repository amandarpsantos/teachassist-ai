/**
 * TeachAssist AI — Artifact Service
 *
 * Owns the meaning and lifecycle of lesson artifacts.
 *
 * TeachAssistDB owns permanent IndexedDB storage.
 * ArtifactService builds and validates artifact metadata,
 * then delegates storage to TeachAssistDB.saveArtifact().
 *
 * Examples:
 * - Microphone Audio
 * - Meeting Audio
 * - Prepared Audio
 * - Transcript
 * - Summary
 * - Homework
 * - Evaluation
 *
 * ArtifactService does NOT know:
 * - how recording works
 * - how transcription works
 * - how AI generation works
 * - how the processing pipeline works
 */

const ArtifactService = (() => {
  const ARTIFACT_TYPES = Object.freeze({
    AUDIO_MICROPHONE: "audio_microphone",
    AUDIO_MEETING: "audio_meeting",
    AUDIO_PREPARED: "audio_prepared",

    TRANSCRIPT: "transcript",
    SUMMARY: "summary",
    HOMEWORK: "homework",
    EVALUATION: "evaluation",
    VOCABULARY: "vocabulary",
    PRONUNCIATION: "pronunciation"
  });

  const CONTENT_KINDS = Object.freeze({
    BINARY: "binary",
    TEXT: "text",
    JSON: "json"
  });

  const ARTIFACT_STATUS = Object.freeze({
    AVAILABLE: "available",
    DELETED: "deleted",
    MISSING: "missing",
    CORRUPT: "corrupt"
  });

  const STORAGE_PROVIDERS = Object.freeze({
    BROWSER: "browser",
    DOWNLOADS: "downloads"
  });

  const CREATOR_TYPES = Object.freeze({
    RECORDER: "recorder",
    AI: "ai",
    USER: "user",
    SYSTEM: "system"
  });

  const VERIFICATION_METHODS = Object.freeze({
    SIZE: "size",
    SIZE_AND_CHECKSUM: "size_and_checksum",
    STORAGE_CONFIRMATION: "storage_confirmation"
  });

  /**
   * Creates or overwrites one artifact.
   *
   * TeachAssist uses one current artifact for each lesson and type.
   * For example, saving a new summary replaces the lesson's
   * existing summary instead of creating Summary v2 or Summary v3.
   */
  async function createArtifact(input = {}) {
    validateCreateInput(input);

    const lessonId = input.lessonId.trim();
    const artifactType = input.type.trim();

    const existingArtifact =
      await TeachAssistDB.getArtifact(
        lessonId,
        artifactType
      );

    const now = new Date().toISOString();

    const artifactId =
      existingArtifact?.metadata?.artifactId ||
      input.artifactId ||
      crypto.randomUUID();

    const generationCount =
      existingArtifact
        ? getExistingGenerationCount(
            existingArtifact
          ) + 1
        : normalizeGenerationCount(
            input.generationCount
          );

    const verificationRequired =
      shouldRequireVerification(
        artifactType,
        input.verificationRequired
      );

    const verification =
      buildVerificationRecord({
        required: verificationRequired,
        verified: input.verified === true,
        verifiedAt: input.verifiedAt,
        method: input.verificationMethod,
        checksum: input.checksum,
        now
      });

    const metadata = {
      artifactId,

      displayName:
        input.displayName.trim(),

      contentKind:
        input.contentKind,

      status:
        input.status ||
        ARTIFACT_STATUS.AVAILABLE,

      storage: {
        provider:
          input.storageProvider ||
          STORAGE_PROVIDERS.BROWSER,

        reference:
          input.storageReference ||
          existingArtifact?.metadata
            ?.storage?.reference ||
          null
      },

      verification,

      sourceArtifactIds:
        normalizeSourceArtifactIds(
          input.sourceArtifactIds
        ),

      creator: {
        type:
          input.creatorType ||
          CREATOR_TYPES.SYSTEM,

        provider:
          input.creatorProvider ||
          null,

        model:
          input.creatorModel ||
          null,

        promptVersion:
          input.promptVersion ||
          null
      },

      generationCount,

      createdAt:
        existingArtifact?.metadata
          ?.createdAt ||
        input.createdAt ||
        now,

      updatedAt: now,

      deletedAt: null,
      deletionReason: null,

      declaredSizeBytes:
        normalizeOptionalSize(
          input.sizeBytes
        ),

      checksum:
        input.checksum ||
        null,

      custom:
        sanitizeMetadata(
          input.metadata || {}
        )
    };

    const savedArtifact =
      await TeachAssistDB.saveArtifact({
        lessonId,
        artifactType,

        data:
          input.data !== undefined
            ? input.data
            : existingArtifact?.data ??
              null,

        filename:
          input.filename !== undefined
            ? input.filename
            : existingArtifact?.filename ??
              null,

        mimeType:
          input.mimeType !== undefined
            ? input.mimeType
            : existingArtifact?.mimeType ??
              null,

        metadata
      });

    await LoggingService.info({
      lessonId,
      stage: "artifact",

      code:
        existingArtifact
          ? "ARTIFACT_OVERWRITTEN"
          : "ARTIFACT_CREATED",

      message:
        existingArtifact
          ? `${metadata.displayName} was updated.`
          : `${metadata.displayName} artifact was created.`,

      metadata: {
        artifactId,
        artifactType,
        displayName:
          metadata.displayName,
        contentKind:
          metadata.contentKind,
        storageProvider:
          metadata.storage.provider,
        verificationRequired:
          metadata.verification.required,
        generationCount
      }
    });

    return normalizeArtifactView(
      savedArtifact
    );
  }

  /**
   * Returns one artifact using its lesson ID and artifact type.
   */
  async function getArtifact(
    lessonId,
    artifactType
  ) {
    requireNonEmptyString(
      lessonId,
      "lessonId"
    );

    requireSupportedArtifactType(
      artifactType
    );

    const artifact =
      await TeachAssistDB.getArtifact(
        lessonId.trim(),
        artifactType.trim()
      );

    return artifact
      ? normalizeArtifactView(artifact)
      : null;
  }

  /**
   * Returns all artifacts belonging to one lesson.
   */
  async function listArtifacts(
    lessonId
  ) {
    requireNonEmptyString(
      lessonId,
      "lessonId"
    );

    const artifacts =
      await TeachAssistDB.listArtifacts(
        lessonId.trim()
      );

    return artifacts.map(
      normalizeArtifactView
    );
  }

  /**
   * Marks an artifact as deleted while removing its saved content.
   *
   * The database record remains so the tutor can see:
   * - that the artifact existed
   * - when it was deleted
   * - why it was deleted
   */
  async function markArtifactDeleted(
    lessonId,
    artifactType,
    input = {}
  ) {
    requireNonEmptyString(
      lessonId,
      "lessonId"
    );

    requireSupportedArtifactType(
      artifactType
    );

    const existingArtifact =
      await TeachAssistDB.getArtifact(
        lessonId.trim(),
        artifactType.trim()
      );

    if (!existingArtifact) {
      throw new Error(
        `Artifact not found: ${artifactType}`
      );
    }

    const now =
      input.deletedAt ||
      new Date().toISOString();

    validateOptionalDate(
      now,
      "deletedAt"
    );

    const existingMetadata =
      existingArtifact.metadata || {};

    const metadata = {
      ...existingMetadata,

      status:
        ARTIFACT_STATUS.DELETED,

      updatedAt: now,
      deletedAt: now,

      deletionReason:
        input.reason ||
        "user_or_privacy_cleanup",

      storage: {
        ...existingMetadata.storage,
        reference: null
      },

      verification: {
        ...existingMetadata.verification,
        verified: false
      }
    };

    const savedArtifact =
      await TeachAssistDB.saveArtifact({
        lessonId:
          existingArtifact.lessonId,

        artifactType:
          existingArtifact.artifactType,

        data: null,

        filename:
          existingArtifact.filename,

        mimeType:
          existingArtifact.mimeType,

        metadata
      });

    await LoggingService.info({
      lessonId:
        existingArtifact.lessonId,

      stage: "artifact",
      code: "ARTIFACT_DELETED",

      message:
        `${getDisplayName(
          existingArtifact
        )} content was deleted.`,

      metadata: {
        artifactId:
          metadata.artifactId ||
          null,

        artifactType:
          existingArtifact.artifactType,

        deletedAt: now,

        deletionReason:
          metadata.deletionReason
      }
    });

    return normalizeArtifactView(
      savedArtifact
    );
  }

  /**
   * Marks an original recording as verified.
   *
   * Verification is intended primarily for microphone,
   * meeting, and prepared audio artifacts.
   */
  async function verifyArtifact(
    lessonId,
    artifactType,
    input = {}
  ) {
    requireNonEmptyString(
      lessonId,
      "lessonId"
    );

    requireSupportedArtifactType(
      artifactType
    );

    const existingArtifact =
      await TeachAssistDB.getArtifact(
        lessonId.trim(),
        artifactType.trim()
      );

    if (!existingArtifact) {
      throw new Error(
        `Artifact not found: ${artifactType}`
      );
    }

    const metadata =
      existingArtifact.metadata || {};

    if (
      !metadata.verification?.required
    ) {
      throw new Error(
        `${getDisplayName(
          existingArtifact
        )} does not require verification.`
      );
    }

    if (
      !existingArtifact.data ||
      Number(existingArtifact.sizeBytes) <= 0
    ) {
      throw new Error(
        `${getDisplayName(
          existingArtifact
        )} cannot be verified because its content is empty.`
      );
    }

    const now =
      input.verifiedAt ||
      new Date().toISOString();

    validateOptionalDate(
      now,
      "verifiedAt"
    );

    const updatedMetadata = {
      ...metadata,

      status:
        ARTIFACT_STATUS.AVAILABLE,

      updatedAt: now,

      checksum:
        input.checksum ||
        metadata.checksum ||
        null,

      verification: {
        required: true,
        verified: true,
        verifiedAt: now,

        method:
          input.method ||
          metadata.verification
            ?.method ||
          VERIFICATION_METHODS.SIZE
      }
    };

    const savedArtifact =
      await TeachAssistDB.saveArtifact({
        lessonId:
          existingArtifact.lessonId,

        artifactType:
          existingArtifact.artifactType,

        data:
          existingArtifact.data,

        filename:
          existingArtifact.filename,

        mimeType:
          existingArtifact.mimeType,

        metadata:
          updatedMetadata
      });

    await LoggingService.info({
      lessonId:
        existingArtifact.lessonId,

      stage: "artifact",
      code: "ARTIFACT_VERIFIED",

      message:
        `${getDisplayName(
          existingArtifact
        )} was verified successfully.`,

      metadata: {
        artifactId:
          updatedMetadata.artifactId ||
          null,

        artifactType:
          existingArtifact.artifactType,

        sizeBytes:
          existingArtifact.sizeBytes,

        verificationMethod:
          updatedMetadata
            .verification
            .method
      }
    });

    return normalizeArtifactView(
      savedArtifact
    );
  }

  /**
   * Convenience method for microphone audio.
   */
  async function saveMicrophoneAudio(
    input = {}
  ) {
    return createArtifact({
      ...input,

      type:
        ARTIFACT_TYPES
          .AUDIO_MICROPHONE,

      displayName:
        input.displayName ||
        "Microphone Audio",

      contentKind:
        CONTENT_KINDS.BINARY,

      mimeType:
        input.mimeType ||
        "audio/webm",

      filename:
        input.filename ||
        "microphone.webm",

      creatorType:
        input.creatorType ||
        CREATOR_TYPES.RECORDER,

      verificationRequired: true
    });
  }

  /**
   * Convenience method for meeting/tab audio.
   */
  async function saveMeetingAudio(
    input = {}
  ) {
    return createArtifact({
      ...input,

      type:
        ARTIFACT_TYPES
          .AUDIO_MEETING,

      displayName:
        input.displayName ||
        "Meeting Audio",

      contentKind:
        CONTENT_KINDS.BINARY,

      mimeType:
        input.mimeType ||
        "audio/webm",

      filename:
        input.filename ||
        "tab_audio.webm",

      creatorType:
        input.creatorType ||
        CREATOR_TYPES.RECORDER,

      verificationRequired: true
    });
  }

  /**
   * Convenience method for prepared/combined audio.
   */
  async function savePreparedAudio(
    input = {}
  ) {
    return createArtifact({
      ...input,

      type:
        ARTIFACT_TYPES
          .AUDIO_PREPARED,

      displayName:
        input.displayName ||
        "Prepared Audio",

      contentKind:
        CONTENT_KINDS.BINARY,

      mimeType:
        input.mimeType ||
        "audio/webm",

      filename:
        input.filename ||
        "prepared_audio.webm",

      creatorType:
        input.creatorType ||
        CREATOR_TYPES.SYSTEM,

      verificationRequired: true
    });
  }

  /**
   * Convenience method for the lesson transcript.
   */
  async function saveTranscript(
    input = {}
  ) {
    return createArtifact({
      ...input,

      type:
        ARTIFACT_TYPES.TRANSCRIPT,

      displayName:
        input.displayName ||
        "Original Transcript",

      contentKind:
        input.contentKind ||
        CONTENT_KINDS.TEXT,

      mimeType:
        input.mimeType ||
        "text/plain",

      filename:
        input.filename ||
        "transcript.txt",

      creatorType:
        input.creatorType ||
        CREATOR_TYPES.AI,

      verificationRequired: false
    });
  }

  /**
   * Convenience method for the class summary.
   */
  async function saveSummary(
    input = {}
  ) {
    return createArtifact({
      ...input,

      type:
        ARTIFACT_TYPES.SUMMARY,

      displayName:
        input.displayName ||
        "Class Summary",

      contentKind:
        input.contentKind ||
        CONTENT_KINDS.TEXT,

      mimeType:
        input.mimeType ||
        "text/plain",

      filename:
        input.filename ||
        "class_summary.txt",

      creatorType:
        input.creatorType ||
        CREATOR_TYPES.AI,

      verificationRequired: false
    });
  }

  /**
   * Convenience method for homework.
   */
  async function saveHomework(
    input = {}
  ) {
    return createArtifact({
      ...input,

      type:
        ARTIFACT_TYPES.HOMEWORK,

      displayName:
        input.displayName ||
        "Homework",

      contentKind:
        input.contentKind ||
        CONTENT_KINDS.TEXT,

      mimeType:
        input.mimeType ||
        "text/plain",

      filename:
        input.filename ||
        "homework.txt",

      creatorType:
        input.creatorType ||
        CREATOR_TYPES.AI,

      verificationRequired: false
    });
  }

  /**
   * Convenience method for a student evaluation.
   */
  async function saveEvaluation(
    input = {}
  ) {
    return createArtifact({
      ...input,

      type:
        ARTIFACT_TYPES.EVALUATION,

      displayName:
        input.displayName ||
        "Student Evaluation",

      contentKind:
        input.contentKind ||
        CONTENT_KINDS.TEXT,

      mimeType:
        input.mimeType ||
        "text/plain",

      filename:
        input.filename ||
        "student_evaluation.txt",

      creatorType:
        input.creatorType ||
        CREATOR_TYPES.AI,

      verificationRequired: false
    });
  }

  function validateCreateInput(input) {
    requireNonEmptyString(
      input.lessonId,
      "lessonId"
    );

    requireSupportedArtifactType(
      input.type
    );

    requireNonEmptyString(
      input.displayName,
      "displayName"
    );

    if (
      !Object.values(
        CONTENT_KINDS
      ).includes(input.contentKind)
    ) {
      throw new Error(
        `Invalid artifact content kind: ${input.contentKind}`
      );
    }

    if (
      input.status !== undefined &&
      !Object.values(
        ARTIFACT_STATUS
      ).includes(input.status)
    ) {
      throw new Error(
        `Invalid artifact status: ${input.status}`
      );
    }

    if (
      input.storageProvider !== undefined &&
      !Object.values(
        STORAGE_PROVIDERS
      ).includes(
        input.storageProvider
      )
    ) {
      throw new Error(
        `Invalid storage provider: ${input.storageProvider}`
      );
    }

    if (
      input.creatorType !== undefined &&
      !Object.values(
        CREATOR_TYPES
      ).includes(input.creatorType)
    ) {
      throw new Error(
        `Invalid artifact creator type: ${input.creatorType}`
      );
    }

    validateOptionalDate(
      input.createdAt,
      "createdAt"
    );

    validateOptionalDate(
      input.verifiedAt,
      "verifiedAt"
    );

    if (
      input.sizeBytes !== undefined &&
      (
        !Number.isFinite(
          input.sizeBytes
        ) ||
        input.sizeBytes < 0
      )
    ) {
      throw new Error(
        "sizeBytes must be a non-negative number."
      );
    }

    if (
      input.verified === true &&
      input.verificationRequired ===
        false
    ) {
      throw new Error(
        "An artifact cannot be verified when verification is not required."
      );
    }
  }

  function requireSupportedArtifactType(
    artifactType
  ) {
    requireNonEmptyString(
      artifactType,
      "artifactType"
    );

    if (
      !Object.values(
        ARTIFACT_TYPES
      ).includes(
        artifactType.trim()
      )
    ) {
      throw new Error(
        `Unsupported artifact type: ${artifactType}`
      );
    }
  }

  function shouldRequireVerification(
    artifactType,
    explicitValue
  ) {
    if (
      typeof explicitValue === "boolean"
    ) {
      return explicitValue;
    }

    return [
      ARTIFACT_TYPES.AUDIO_MICROPHONE,
      ARTIFACT_TYPES.AUDIO_MEETING,
      ARTIFACT_TYPES.AUDIO_PREPARED
    ].includes(artifactType);
  }

  function buildVerificationRecord({
    required,
    verified,
    verifiedAt,
    method,
    checksum,
    now
  }) {
    if (!required) {
      return {
        required: false,
        verified: false,
        verifiedAt: null,
        method: null
      };
    }

    return {
      required: true,
      verified,

      verifiedAt:
        verified
          ? verifiedAt || now
          : null,

      method:
        method ||
        (
          checksum
            ? VERIFICATION_METHODS
                .SIZE_AND_CHECKSUM
            : VERIFICATION_METHODS.SIZE
        )
    };
  }

  function normalizeArtifactView(
    artifact
  ) {
    const metadata =
      artifact.metadata || {};

    return {
      artifactId:
        metadata.artifactId ||
        artifact.artifactKey,

      artifactKey:
        artifact.artifactKey,

      lessonId:
        artifact.lessonId,

      type:
        artifact.artifactType,

      displayName:
        metadata.displayName ||
        artifact.artifactType,

      contentKind:
        metadata.contentKind ||
        inferContentKind(artifact),

      status:
        metadata.status ||
        ARTIFACT_STATUS.AVAILABLE,

      filename:
        artifact.filename ||
        null,

      mimeType:
        artifact.mimeType ||
        null,

      sizeBytes:
        artifact.sizeBytes,

      data:
        artifact.data,

      storage:
        metadata.storage || {
          provider:
            STORAGE_PROVIDERS.BROWSER,
          reference: null
        },

      verification:
        metadata.verification || {
          required: false,
          verified: false,
          verifiedAt: null,
          method: null
        },

      sourceArtifactIds:
        metadata.sourceArtifactIds ||
        [],

      creator:
        metadata.creator || {
          type:
            CREATOR_TYPES.SYSTEM,
          provider: null,
          model: null,
          promptVersion: null
        },

      generationCount:
        metadata.generationCount || 1,

      checksum:
        metadata.checksum || null,

      createdAt:
        metadata.createdAt ||
        artifact.createdAt,

      updatedAt:
        metadata.updatedAt ||
        artifact.updatedAt,

      deletedAt:
        metadata.deletedAt ||
        null,

      deletionReason:
        metadata.deletionReason ||
        null,

      metadata:
        metadata.custom || {}
    };
  }

  function inferContentKind(
    artifact
  ) {
    if (
      artifact.data instanceof Blob ||
      artifact.data instanceof ArrayBuffer ||
      ArrayBuffer.isView(
        artifact.data
      )
    ) {
      return CONTENT_KINDS.BINARY;
    }

    if (
      typeof artifact.data === "string"
    ) {
      return CONTENT_KINDS.TEXT;
    }

    return CONTENT_KINDS.JSON;
  }

  function getExistingGenerationCount(
    artifact
  ) {
    const count =
      artifact?.metadata
        ?.generationCount;

    return Number.isInteger(count) &&
      count > 0
      ? count
      : 1;
  }

  function normalizeGenerationCount(
    value
  ) {
    return Number.isInteger(value) &&
      value > 0
      ? value
      : 1;
  }

  function normalizeOptionalSize(
    value
  ) {
    if (
      Number.isFinite(value) &&
      value >= 0
    ) {
      return Math.round(value);
    }

    return null;
  }

  function normalizeSourceArtifactIds(
    sourceArtifactIds
  ) {
    if (
      sourceArtifactIds === undefined ||
      sourceArtifactIds === null
    ) {
      return [];
    }

    if (
      !Array.isArray(
        sourceArtifactIds
      )
    ) {
      throw new TypeError(
        "sourceArtifactIds must be an array."
      );
    }

    return [
      ...new Set(
        sourceArtifactIds
          .filter(
            value =>
              typeof value === "string"
          )
          .map(
            value => value.trim()
          )
          .filter(Boolean)
      )
    ];
  }

  /**
   * Removes sensitive values from custom artifact metadata.
   */
  function sanitizeMetadata(
    metadata
  ) {
    if (
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata)
    ) {
      return {};
    }

    const sanitized =
      deepSanitize(metadata);

    return sanitized;
  }

  function deepSanitize(value) {
    if (Array.isArray(value)) {
      return value.map(
        deepSanitize
      );
    }

    if (
      !value ||
      typeof value !== "object"
    ) {
      return value;
    }

    const result = {};

    for (
      const [key, item] of
      Object.entries(value)
    ) {
      if (isSensitiveKey(key)) {
        result[key] =
          "[REDACTED]";
      } else {
        result[key] =
          deepSanitize(item);
      }
    }

    return result;
  }

  function isSensitiveKey(key) {
    const normalizedKey =
      String(key)
        .replace(/[_-]/g, "")
        .toLowerCase();

    return [
      "apikey",
      "authorization",
      "token",
      "accesstoken",
      "refreshtoken",
      "password",
      "secret"
    ].includes(normalizedKey);
  }

  function getDisplayName(
    artifact
  ) {
    return (
      artifact?.metadata
        ?.displayName ||
      artifact?.artifactType ||
      "Artifact"
    );
  }

  function validateOptionalDate(
    value,
    fieldName
  ) {
    if (
      value !== undefined &&
      value !== null &&
      Number.isNaN(
        Date.parse(value)
      )
    ) {
      throw new Error(
        `${fieldName} must be a valid date.`
      );
    }
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
    ARTIFACT_TYPES,
    CONTENT_KINDS,
    ARTIFACT_STATUS,
    STORAGE_PROVIDERS,
    CREATOR_TYPES,
    VERIFICATION_METHODS,

    createArtifact,
    getArtifact,
    listArtifacts,
    markArtifactDeleted,
    verifyArtifact,

    saveMicrophoneAudio,
    saveMeetingAudio,
    savePreparedAudio,
    saveTranscript,
    saveSummary,
    saveHomework,
    saveEvaluation
  });
})();

// Phase 2.6: `const ArtifactService = (() => {...})();` at the top
// level of a classic (non-module) script creates a global-scope
// binding usable as the bare identifier `ArtifactService` by any
// other classic script sharing this realm (background.js via
// importScripts, offscreen.js via its own <script> tag) — but it does
// NOT attach to `window`/`self` the way a `var` or function
// declaration would. The dashboard's manual recovery-upload flow
// (ExtensionDataAdapter.uploadRecoveredRecording()) specifically
// reads `window.ArtifactService`, which was therefore always
// undefined, throwing "Cannot read properties of undefined (reading
// 'savePreparedAudio')" the moment a teacher tried to upload a local
// recording for a lesson with no audio. globalThis is the same object
// as `window` in the dashboard/offscreen page context, and the same
// object as `self` in the background.js service-worker context (where
// nothing currently reads it, so this line is a harmless no-op
// there) — one assignment, safe and correct in every context this
// script is loaded into.
globalThis.ArtifactService = ArtifactService;
