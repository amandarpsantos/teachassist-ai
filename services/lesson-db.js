/**
 * TeachAssist AI — Lesson Database
 *
 * Permanent local storage for:
 * - lesson metadata
 * - original audio artifacts
 * - processing artifacts
 * - pipeline state
 * - diagnostic logs
 *
 * This file deliberately contains no recording, transcription,
 * AI, or dashboard logic.
 */

const TeachAssistDB = (() => {
  const DATABASE_NAME = "TeachAssistDB";
  // services/recording-chunk-store.js opens this same database name
  // and MUST use the identical DATABASE_VERSION — see the comment on
  // its own DATABASE_VERSION constant for why a mismatch is a hard
  // failure (VersionError) on every recording start, not a rare edge
  // case, and why it's currently 4 rather than matching this file's
  // pre-existing 3. Bump both together, always.
  const DATABASE_VERSION = 4;

  const STORES = Object.freeze({
    LESSONS: "lessons",
    ARTIFACTS: "artifacts",
    PIPELINE: "pipeline",
    LOGS: "logs",
    STUDENTS: "students"
  });

  let databasePromise = null;

  /**
   * Opens the database and creates its stores when necessary.
   */
  function initializeDatabase() {
    if (databasePromise) {
      return databasePromise;
    }

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = (event) => {
        const database = event.target.result;

        if (!database.objectStoreNames.contains(STORES.LESSONS)) {
          const lessonsStore = database.createObjectStore(STORES.LESSONS, {
            keyPath: "lessonId"
          });

          lessonsStore.createIndex("createdAt", "createdAt", {
            unique: false
          });

          lessonsStore.createIndex("updatedAt", "updatedAt", {
            unique: false
          });

          lessonsStore.createIndex("overallStatus", "overallStatus", {
            unique: false
          });

          lessonsStore.createIndex("studentName", "student.name", {
            unique: false
          });
        }

        if (!database.objectStoreNames.contains(STORES.ARTIFACTS)) {
          const artifactsStore = database.createObjectStore(
            STORES.ARTIFACTS,
            {
              keyPath: "artifactKey"
            }
          );

          artifactsStore.createIndex("lessonId", "lessonId", {
            unique: false
          });

          artifactsStore.createIndex("artifactType", "artifactType", {
            unique: false
          });

          artifactsStore.createIndex(
            "lessonIdAndType",
            ["lessonId", "artifactType"],
            {
              unique: false
            }
          );
        }

        if (!database.objectStoreNames.contains(STORES.PIPELINE)) {
          const pipelineStore = database.createObjectStore(
            STORES.PIPELINE,
            {
              keyPath: "lessonId"
            }
          );

          pipelineStore.createIndex("overallStatus", "overallStatus", {
            unique: false
          });

          pipelineStore.createIndex("updatedAt", "updatedAt", {
            unique: false
          });
        }

        if (!database.objectStoreNames.contains(STORES.LOGS)) {
          const logsStore = database.createObjectStore(STORES.LOGS, {
            keyPath: "logId",
            autoIncrement: true
          });

          logsStore.createIndex("lessonId", "lessonId", {
            unique: false
          });

          logsStore.createIndex("stage", "stage", {
            unique: false
          });

          logsStore.createIndex("timestamp", "timestamp", {
            unique: false
          });

          logsStore.createIndex(
            "lessonIdAndTimestamp",
            ["lessonId", "timestamp"],
            {
              unique: false
            }
          );
        }

        // Defensive/duplicate definition — see the top-of-file comment
        // in services/recording-chunk-store.js for why this appears
        // here too rather than only there.
        if (!database.objectStoreNames.contains("recordingChunks")) {
          const chunksStore = database.createObjectStore("recordingChunks", {
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

        if (!database.objectStoreNames.contains("recordingChunkSessions")) {
          database.createObjectStore("recordingChunkSessions", {
            keyPath: "sessionId"
          });
        }

        if (!database.objectStoreNames.contains(STORES.STUDENTS)) {
          const studentsStore = database.createObjectStore(
            STORES.STUDENTS,
            {
              keyPath: "studentId"
            }
          );

          studentsStore.createIndex("updatedAt", "updatedAt", {
            unique: false
          });
        }
      };

      request.onsuccess = () => {
        const database = request.result;

        database.onversionchange = () => {
          database.close();
          databasePromise = null;
        };

        resolve(database);
      };

      request.onerror = () => {
        databasePromise = null;
        reject(
          new Error(
            `Could not open ${DATABASE_NAME}: ${
              request.error?.message || "Unknown IndexedDB error"
            }`
          )
        );
      };

      request.onblocked = () => {
        console.warn(
          "TeachAssistDB upgrade is blocked by another open extension context."
        );
      };
    });

    return databasePromise;
  }

  /**
   * Creates a stable lesson ID.
   */
  function createLessonId() {
    const datePart = new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 14);

    const randomPart =
      typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID().split("-")[0]
        : Math.random().toString(36).slice(2, 10);

    return `lesson_${datePart}_${randomPart}`;
  }

  /**
   * Creates the standard initial pipeline state.
   */
  function createInitialPipelineState(lessonId) {
    const now = new Date().toISOString();

    return {
      lessonId,
      overallStatus: "pending",
      currentStage: "inspection",
      createdAt: now,
      updatedAt: now,

      stages: {
        recording: {
          status: "completed",
          attempts: 1,
          startedAt: null,
          finishedAt: now,
          error: null
        },

        inspection: createWaitingStage("pending"),
        validation: createWaitingStage("waiting"),
        transcription: createWaitingStage("waiting"),
        transcriptCleanup: createWaitingStage("waiting"),
        summary: createWaitingStage("waiting"),
        teaching_snapshot: createWaitingStage("waiting"),
        dashboardUpload: createWaitingStage("waiting")
      }
    };
  }

  function createWaitingStage(status = "waiting") {
    return {
      status,
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      error: null
    };
  }

  /**
   * Creates a complete initial lesson record.
   */
  function buildLessonRecord(input = {}) {
    const lessonId = input.lessonId || createLessonId();
    const now = new Date().toISOString();

    return {
      lessonId,
      schemaVersion: 1,

      createdAt: input.createdAt || now,
      updatedAt: now,

      student: {
        studentId: input.studentId || null,
        name: input.studentName || "Unknown Student"
      },

      class: {
        title: input.classTitle || "English Class",
        program: input.classProgram || null,
        platform: input.platform || null,
        meetingUrl: input.meetingUrl || null
      },

      languagePair: {
        targetLanguage: "en",
        nativeLanguage: "pt-BR"
      },

      recording: {
        status: input.recordingStatus || "pending",

        startedAt: input.startedAt || null,
        stoppedAt: input.stoppedAt || null,

        recorderMeasuredDurationMs:
          Number.isFinite(input.recorderMeasuredDurationMs)
            ? input.recorderMeasuredDurationMs
            : null,

        tracks: {
          microphone: createEmptyTrack("microphone.webm"),
          meeting: createEmptyTrack("tab_audio.webm")
        }
      },

      overallStatus: "pending"
    };
  }

  function createEmptyTrack(filename) {
    return {
      artifactId: null,
      filename,
      mimeType: "audio/webm",
      sizeBytes: null,
      status: "pending",
      error: null
    };
  }

  /**
   * Saves a new lesson and its initial pipeline state in one transaction.
   */
  async function createLesson(lessonInput = {}) {
    const database = await initializeDatabase();
    const lesson = buildLessonRecord(lessonInput);
    const pipeline = createInitialPipelineState(lesson.lessonId);

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [STORES.LESSONS, STORES.PIPELINE],
        "readwrite"
      );

      transaction.objectStore(STORES.LESSONS).add(lesson);
      transaction.objectStore(STORES.PIPELINE).add(pipeline);

      transaction.oncomplete = () => {
        resolve({
          lesson,
          pipeline
        });
      };

      transaction.onerror = () => {
        reject(
          transaction.error ||
            new Error("Could not create the TeachAssist lesson.")
        );
      };

      transaction.onabort = () => {
        reject(
          transaction.error ||
            new Error("Lesson creation transaction was aborted.")
        );
      };
    });
  }

  /**
   * Phase 2, Part F/G/L — logical lesson merge / session consolidation.
   *
   * Creates one new "parent" lesson record representing the combined
   * logical class, and marks every source lesson with a mergedInto
   * pointer to it. Never touches a source lesson's own artifacts,
   * transcript, or recording — those remain exactly where they were,
   * addressable by their own unchanged lessonId. The parent's own
   * displayed status (Ready/Processing/Needs Attention) is computed
   * by the dashboard from its sources' own already-computed statuses
   * (see mapMergedLessonStatus() in dashboard/src/data/mappers.ts) —
   * this function only performs the mechanical, atomic write.
   *
   * Atomicity: modeled directly on createLesson() above, which already
   * proves this database supports a single readwrite transaction
   * spanning both STORES.LESSONS and STORES.PIPELINE with multiple
   * queued operations. Every write below — the new parent lesson, the
   * new parent pipeline row, and every source lesson's mergedInto
   * update — is issued against ONE transaction object. IndexedDB
   * commits a transaction only once every request queued against it
   * has completed with no further requests queued; if any one request
   * fails, the whole transaction aborts and nothing above is
   * committed, including the parent lesson/pipeline already queued —
   * there is no window where a partial merge (some sources marked,
   * others not, or a parent with no sources) can be observed.
   */
  async function mergeLessons({ sourceLessonIds, studentId, studentName, classTitle } = {}) {
    if (!Array.isArray(sourceLessonIds) || sourceLessonIds.length < 2) {
      throw new TypeError("mergeLessons requires at least two sourceLessonIds.");
    }

    const uniqueSourceLessonIds = Array.from(new Set(sourceLessonIds));
    if (uniqueSourceLessonIds.length !== sourceLessonIds.length) {
      throw new Error("mergeLessons received duplicate lessonIds in the same request.");
    }

    const database = await initializeDatabase();

    // Read-and-validate every source OUTSIDE the write transaction —
    // existence and already-merged checks are read-only and should
    // not hold a readwrite transaction open while doing them. This
    // mirrors getLesson()'s own existing read pattern.
    const sourceLessons = [];
    for (const lessonId of uniqueSourceLessonIds) {
      const lesson = await getRecord(STORES.LESSONS, lessonId);
      if (!lesson) {
        throw new Error(`Lesson not found: ${lessonId}`);
      }
      if (lesson.mergedInto) {
        // Part K: prevent duplicate merging outright — never silently
        // skip an already-merged source.
        throw new Error(
          `Lesson ${lessonId} is already merged into ${lesson.mergedInto}.`
        );
      }
      sourceLessons.push(lesson);
    }

    // Chronological order by each source's own recorded start time —
    // never invented, only derived from real stored fields, with
    // createdAt as the fallback for a source that never captured
    // recording.startedAt.
    sourceLessons.sort((a, b) => {
      const aTime = Date.parse(a.recording?.startedAt || a.createdAt || 0) || 0;
      const bTime = Date.parse(b.recording?.startedAt || b.createdAt || 0) || 0;
      return aTime - bTime;
    });

    const orderedSourceLessonIds = sourceLessons.map((lesson) => lesson.lessonId);
    const earliest = sourceLessons[0];
    const latest = sourceLessons[sourceLessons.length - 1];

    // Sum of each source's own recorder-measured duration — never
    // (latest timestamp - earliest timestamp), which would incorrectly
    // count the gaps between separate recording sessions as class time.
    const totalDurationMs = sourceLessons.reduce((sum, lesson) => {
      const durationMs = lesson.recording?.recorderMeasuredDurationMs;
      return sum + (Number.isFinite(durationMs) ? durationMs : 0);
    }, 0);

    const parentLesson = buildLessonRecord({
      studentId: studentId ?? earliest.student?.studentId ?? null,
      studentName: studentName ?? earliest.student?.name ?? "Unknown Student",
      classTitle: classTitle ?? earliest.class?.title ?? "English Class",
      classProgram: earliest.class?.program ?? null,
      platform: earliest.class?.platform ?? null,
      meetingUrl: earliest.class?.meetingUrl ?? null,
      createdAt: earliest.createdAt,
      startedAt: earliest.recording?.startedAt ?? null,
      stoppedAt: latest.recording?.stoppedAt ?? null,
      recorderMeasuredDurationMs: totalDurationMs,
      // The parent has no real MediaRecorder session of its own — its
      // "recording" is the union of its sources', each already
      // completed (or not) on its own terms. "completed" here only
      // means "there is nothing left to record for the parent itself"
      // — it does NOT assert every source's recording succeeded; that
      // distinction is preserved per-source and surfaced by the
      // dashboard's status derivation, not collapsed here.
      recordingStatus: "completed"
    });

    parentLesson.mergedFrom = orderedSourceLessonIds;
    parentLesson.isMergeParent = true;

    const parentPipeline = createInitialPipelineState(parentLesson.lessonId);
    const nowIso = new Date().toISOString();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [STORES.LESSONS, STORES.PIPELINE],
        "readwrite"
      );

      transaction.objectStore(STORES.LESSONS).add(parentLesson);
      transaction.objectStore(STORES.PIPELINE).add(parentPipeline);

      // Re-read + re-write each source lesson INSIDE this same
      // transaction — not via updateLesson(), which opens its own,
      // separate transaction per call and would break atomicity with
      // the parent writes above. If a source's own record has changed
      // since the pre-check above (e.g. a concurrent delete), this
      // request still resolves against the current record; a missing
      // record aborts the whole transaction rather than silently
      // proceeding with a partial merge.
      const lessonsStore = transaction.objectStore(STORES.LESSONS);
      for (const lessonId of orderedSourceLessonIds) {
        const getRequest = lessonsStore.get(lessonId);
        getRequest.onsuccess = () => {
          const current = getRequest.result;
          if (!current) {
            transaction.abort();
            return;
          }
          lessonsStore.put({
            ...current,
            mergedInto: parentLesson.lessonId,
            updatedAt: nowIso
          });
        };
      }

      transaction.oncomplete = () => {
        resolve({
          parentLesson,
          parentPipeline,
          sourceLessonIds: orderedSourceLessonIds
        });
      };

      transaction.onerror = () => {
        reject(transaction.error || new Error("Could not merge lessons."));
      };

      transaction.onabort = () => {
        reject(transaction.error || new Error("Lesson merge transaction was aborted."));
      };
    });
  }

  async function getLesson(lessonId) {
    requireString(lessonId, "lessonId");

    return getRecord(STORES.LESSONS, lessonId);
  }

  async function updateLesson(lessonId, updates = {}) {
    requireString(lessonId, "lessonId");

    const existingLesson = await getLesson(lessonId);

    if (!existingLesson) {
      throw new Error(`Lesson not found: ${lessonId}`);
    }

    const updatedLesson = deepMerge(existingLesson, updates);

    updatedLesson.lessonId = lessonId;
    updatedLesson.updatedAt = new Date().toISOString();

    await putRecord(STORES.LESSONS, updatedLesson);

    return updatedLesson;
  }

  /**
   * Reads a student's Teaching Snapshot record. Returns null if the
   * student has no snapshot yet (e.g. before their first completed
   * lesson) — a normal, expected case, not an error.
   */
  async function getStudentSnapshot(studentId) {
    requireString(studentId, "studentId");

    return getRecord(STORES.STUDENTS, studentId);
  }

  /**
   * Creates or updates a student's Teaching Snapshot record. Uses the
   * same deepMerge() as updateLesson(), so a snapshot update can only
   * ever touch the fields it actually provides — it can never wipe
   * unrelated fields on the existing record, and on a student's first
   * lesson (no existing record) it simply creates one from the
   * updates given.
   */
  async function saveStudentSnapshot(studentId, updates = {}) {
    requireString(studentId, "studentId");

    const existingStudent = await getStudentSnapshot(studentId);

    const updatedStudent = existingStudent
      ? deepMerge(existingStudent, updates)
      : { studentId, ...updates };

    updatedStudent.studentId = studentId;
    updatedStudent.updatedAt = new Date().toISOString();

    await putRecord(STORES.STUDENTS, updatedStudent);

    return updatedStudent;
  }

  async function listLessons(options = {}) {
    const database = await initializeDatabase();

    const direction =
      options.direction === "oldest" ? "next" : "prev";

    const limit =
      Number.isInteger(options.limit) && options.limit > 0
        ? options.limit
        : null;

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        STORES.LESSONS,
        "readonly"
      );

      const store = transaction.objectStore(STORES.LESSONS);
      const index = store.index("createdAt");
      const request = index.openCursor(null, direction);
      const lessons = [];

      request.onsuccess = () => {
        const cursor = request.result;

        if (!cursor || (limit && lessons.length >= limit)) {
          resolve(lessons);
          return;
        }

        lessons.push(cursor.value);
        cursor.continue();
      };

      request.onerror = () => {
        reject(
          request.error || new Error("Could not list lessons.")
        );
      };
    });
  }

  /**
   * Stores an artifact such as:
   * - original audio
   * - inspection JSON
   * - transcript
   * - summary
   *
   * `data` may be a Blob, ArrayBuffer, object, string, or null.
   */
  async function saveArtifact({
    lessonId,
    artifactType,
    data,
    filename = null,
    mimeType = null,
    metadata = {}
  }) {
    requireString(lessonId, "lessonId");
    requireString(artifactType, "artifactType");

    const lesson = await getLesson(lessonId);

    if (!lesson) {
      throw new Error(
        `Cannot save artifact because lesson does not exist: ${lessonId}`
      );
    }

    const now = new Date().toISOString();
    const artifactKey = `${lessonId}::${artifactType}`;

    const artifact = {
      artifactKey,
      lessonId,
      artifactType,

      filename,
      mimeType:
        mimeType ||
        (data instanceof Blob ? data.type || null : null),

      sizeBytes: determineSize(data),

      data,
      metadata,

      createdAt: now,
      updatedAt: now
    };

    const existingArtifact = await getArtifact(
      lessonId,
      artifactType
    );

    if (existingArtifact?.createdAt) {
      artifact.createdAt = existingArtifact.createdAt;
    }

    await putRecord(STORES.ARTIFACTS, artifact);

    return artifact;
  }

  async function getArtifact(lessonId, artifactType) {
    requireString(lessonId, "lessonId");
    requireString(artifactType, "artifactType");

    const artifactKey = `${lessonId}::${artifactType}`;
    return getRecord(STORES.ARTIFACTS, artifactKey);
  }

  async function listArtifacts(lessonId) {
    requireString(lessonId, "lessonId");

    const database = await initializeDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        STORES.ARTIFACTS,
        "readonly"
      );

      const index = transaction
        .objectStore(STORES.ARTIFACTS)
        .index("lessonId");

      const request = index.getAll(lessonId);

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        reject(
          request.error || new Error("Could not list lesson artifacts.")
        );
      };
    });
  }

  async function getPipelineState(lessonId) {
    requireString(lessonId, "lessonId");

    return getRecord(STORES.PIPELINE, lessonId);
  }

  async function savePipelineState(lessonId, pipelineState) {
    requireString(lessonId, "lessonId");

    const state = {
      ...pipelineState,
      lessonId,
      updatedAt: new Date().toISOString()
    };

    await putRecord(STORES.PIPELINE, state);
    return state;
  }

  async function updatePipelineStage(
    lessonId,
    stageName,
    updates = {}
  ) {
    requireString(lessonId, "lessonId");
    requireString(stageName, "stageName");

    const pipeline =
      (await getPipelineState(lessonId)) ||
      createInitialPipelineState(lessonId);

    // Self-healing rather than a hard failure: a stage introduced
    // after a lesson's pipeline record was already created (e.g.
    // "teaching_snapshot", added once the Teaching Snapshot feature
    // existed) would otherwise throw "Unknown pipeline stage" for
    // every lesson recorded before that point, forever — there is no
    // migration pass over existing records. Initializing it as a
    // normal "waiting" stage the first time it's touched makes a
    // genuinely new stage name safe to introduce at any time, while
    // still keeping this a deliberate, explicit stage set — nothing
    // here silently accepts a typo, it only accepts a name this
    // function's own caller chose to use.
    if (!pipeline.stages) pipeline.stages = {};
    if (!pipeline.stages[stageName]) {
      pipeline.stages[stageName] = createWaitingStage("waiting");
    }

    pipeline.stages[stageName] = deepMerge(
      pipeline.stages[stageName],
      updates
    );

    pipeline.updatedAt = new Date().toISOString();

    await savePipelineState(lessonId, pipeline);
    return pipeline;
  }

  async function appendLog({
    lessonId,
    stage = "system",
    severity = "info",
    code = null,
    message,
    technicalDetails = null,
    metadata = {}
  }) {
    requireString(lessonId, "lessonId");
    requireString(message, "message");

    const database = await initializeDatabase();

    const logEntry = {
      lessonId,
      stage,
      severity,
      code,
      message,
      technicalDetails,
      metadata,
      timestamp: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        STORES.LOGS,
        "readwrite"
      );

      const request = transaction
        .objectStore(STORES.LOGS)
        .add(logEntry);

      request.onsuccess = () => {
        resolve({
          ...logEntry,
          logId: request.result
        });
      };

      request.onerror = () => {
        reject(
          request.error || new Error("Could not save diagnostic log.")
        );
      };
    });
  }

  /**
   * Returns every student's current Teaching Snapshot record. Used
   * by the dashboard snapshot fetch, the same way listArtifacts()
   * feeds the artifacts list — one full read per dashboard refresh.
   */
  async function listStudentSnapshots() {
    const database = await initializeDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        STORES.STUDENTS,
        "readonly"
      );

      const request = transaction.objectStore(STORES.STUDENTS).getAll();

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        reject(
          request.error || new Error("Could not read student snapshots.")
        );
      };
    });
  }

  async function getLogs(lessonId) {
    requireString(lessonId, "lessonId");

    const database = await initializeDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        STORES.LOGS,
        "readonly"
      );

      const index = transaction
        .objectStore(STORES.LOGS)
        .index("lessonIdAndTimestamp");

      const range = IDBKeyRange.bound(
        [lessonId, ""],
        [lessonId, "\uffff"]
      );

      const request = index.getAll(range);

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        reject(
          request.error || new Error("Could not read diagnostic logs.")
        );
      };
    });
  }

  async function deleteLesson(lessonId) {
    requireString(lessonId, "lessonId");

    const database = await initializeDatabase();

    const artifacts = await listArtifacts(lessonId);
    const logs = await getLogs(lessonId);

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [
          STORES.LESSONS,
          STORES.ARTIFACTS,
          STORES.PIPELINE,
          STORES.LOGS
        ],
        "readwrite"
      );

      transaction.objectStore(STORES.LESSONS).delete(lessonId);
      transaction.objectStore(STORES.PIPELINE).delete(lessonId);

      const artifactsStore =
        transaction.objectStore(STORES.ARTIFACTS);

      for (const artifact of artifacts) {
        artifactsStore.delete(artifact.artifactKey);
      }

      const logsStore = transaction.objectStore(STORES.LOGS);

      for (const log of logs) {
        logsStore.delete(log.logId);
      }

      transaction.oncomplete = () => resolve(true);

      transaction.onerror = () => {
        reject(
          transaction.error ||
            new Error("Could not delete lesson data.")
        );
      };
    });
  }

  async function getRecord(storeName, key) {
    const database = await initializeDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        storeName,
        "readonly"
      );

      const request = transaction
        .objectStore(storeName)
        .get(key);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        reject(
          request.error ||
            new Error(`Could not read from ${storeName}.`)
        );
      };
    });
  }

  async function putRecord(storeName, record) {
    const database = await initializeDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        storeName,
        "readwrite"
      );

      const request = transaction
        .objectStore(storeName)
        .put(record);

      request.onsuccess = () => resolve(request.result);

      request.onerror = () => {
        reject(
          request.error ||
            new Error(`Could not write to ${storeName}.`)
        );
      };
    });
  }

  function determineSize(data) {
    if (data instanceof Blob) {
      return data.size;
    }

    if (data instanceof ArrayBuffer) {
      return data.byteLength;
    }

    if (ArrayBuffer.isView(data)) {
      return data.byteLength;
    }

    if (typeof data === "string") {
      return new Blob([data]).size;
    }

    if (data && typeof data === "object") {
      try {
        return new Blob([JSON.stringify(data)]).size;
      } catch {
        return null;
      }
    }

    return 0;
  }

  function deepMerge(original, updates) {
    if (!isPlainObject(original) || !isPlainObject(updates)) {
      return updates;
    }

    const result = { ...original };

    for (const [key, value] of Object.entries(updates)) {
      if (
        isPlainObject(value) &&
        isPlainObject(result[key])
      ) {
        result[key] = deepMerge(result[key], value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  function isPlainObject(value) {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Blob) &&
      !(value instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(value)
    );
  }

  function requireString(value, fieldName) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(
        `${fieldName} must be a non-empty string.`
      );
    }
  }

  return Object.freeze({
    initializeDatabase,
    createLessonId,
    createInitialPipelineState,
    buildLessonRecord,

    createLesson,
    getLesson,
    updateLesson,
    listLessons,
    deleteLesson,
    mergeLessons,

    saveArtifact,
    getArtifact,
    listArtifacts,

    getPipelineState,
    savePipelineState,
    updatePipelineStage,

    getStudentSnapshot,
    saveStudentSnapshot,
    listStudentSnapshots,

    appendLog,
    getLogs
  });
})();

// Phase 2.6: see the matching comment in artifact-service.js — same
// window/self vs. bare-identifier gap, fixed the same way for
// TeachAssistDB specifically (read via window.TeachAssistDB by
// ExtensionDataAdapter.uploadRecoveredRecording()).
globalThis.TeachAssistDB = TeachAssistDB;
