/*
 * TeachAssist AI
 * JobService
 *
 * Owns the lifecycle and status of processing jobs.
 *
 * A job represents the work that happens after a lesson recording:
 *
 * recording
 * → transcription
 * → summary
 * → homework
 * → completion
 */

const JobService = (() => {
  const STORAGE_KEY = "teachAssistJobs";

  const JOB_STATUS = Object.freeze({
    CREATED: "created",
    PROCESSING: "processing",
    COMPLETED: "completed",
    FAILED: "failed"
  });

  const JOB_STEP = Object.freeze({
    RECORDING: "recording",
    TRANSCRIPTION: "transcription",
    SUMMARY: "summary",
    TEACHING_SNAPSHOT: "teaching_snapshot",
    HOMEWORK: "homework",
    COMPLETE: "complete"
  });

  function nowIso() {
    return new Date().toISOString();
  }

  function createId() {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }

    return [
      "job",
      Date.now(),
      Math.random().toString(16).slice(2)
    ].join("_");
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  async function readJobs() {
    const data = await chrome.storage.local.get([
      STORAGE_KEY
    ]);

    const jobs = data[STORAGE_KEY];

    return Array.isArray(jobs)
      ? jobs
      : [];
  }

  async function writeJobs(jobs) {
    if (!Array.isArray(jobs)) {
      throw new TypeError(
        "JobService.writeJobs expected an array."
      );
    }

    await chrome.storage.local.set({
      [STORAGE_KEY]: jobs
    });
  }

  /*
   * Serializes every operation that reads-then-writes (or reads-then-
   * conditionally-writes) the jobs list, so two concurrent calls can
   * never both read the same pre-write snapshot and then overwrite
   * each other's result — the exact "Job not found" failure mode:
   * two jobs created in the same tick (e.g. the dashboard's automatic
   * summary-generation effect firing for several lessons at once)
   * could each read the jobs array before the other's write landed,
   * so whichever writeJobs() call happened second would silently
   * erase the first job from storage entirely, even though its jobId
   * had already been handed back to the caller — later failing with
   * "Job not found" the moment that caller tried to update it. Same
   * fix shape already applied to background.js's own diagnostic-log
   * writes for the identical class of race.
   */
  let jobsQueue = Promise.resolve();

  function withJobsQueue(operation) {
    const result = jobsQueue.then(operation);
    jobsQueue = result.catch(() => {});
    return result;
  }

  async function initialize() {
    const jobs = await readJobs();

    /*
     * Ensures that the storage key exists even when
     * the extension has never created a job.
     */
    await writeJobs(jobs);

    return {
      ok: true,
      jobCount: jobs.length
    };
  }

  async function createJob({
    lessonId = null,
    sessionId = null,
    groupId = null,
    meetingTitle = null,
    metadata = {}
  } = {}) {
    return withJobsQueue(async () => {
    if (!lessonId && !sessionId) {
      throw new Error(
        "A job requires either a lessonId or sessionId."
      );
    }

    const jobs = await readJobs();
    const timestamp = nowIso();

    const job = {
      jobId: createId(),

      lessonId,
      sessionId,
      groupId,
      meetingTitle,

      status: JOB_STATUS.CREATED,
      currentStep: JOB_STEP.RECORDING,

      createdAt: timestamp,
      startedAt: null,
      updatedAt: timestamp,
      completedAt: null,
      failedAt: null,

      error: null,

      artifacts: {
        microphoneRecording: null,
        tabRecording: null,
        transcript: null,
        summary: null,
        homework: null
      },

      metadata: {
        ...metadata
      }
    };

    jobs.push(job);
    await writeJobs(jobs);

    return clone(job);
    });
  }

  async function getJob(jobId) {
    if (!jobId) {
      throw new Error(
        "JobService.getJob requires a jobId."
      );
    }

    const jobs = await readJobs();

    const job = jobs.find(
      item => item.jobId === jobId
    );

    return job
      ? clone(job)
      : null;
  }

  async function getJobBySessionId(sessionId) {
    if (!sessionId) {
      throw new Error(
        "JobService.getJobBySessionId requires a sessionId."
      );
    }

    const jobs = await readJobs();

    /*
     * Search from newest to oldest in case a session
     * has been reprocessed more than once.
     */
    const job = [...jobs]
      .reverse()
      .find(item => item.sessionId === sessionId);

    return job
      ? clone(job)
      : null;
  }

  async function ensureJobForSession({
      lessonId = null,
      sessionId,
      groupId = null,
      meetingTitle = null,
      metadata = {}
    } = {}) {
      if (!sessionId) {
        throw new Error(
          "JobService.ensureJobForSession requires a sessionId."
        );
      }
    
      const existingJob =
        await getJobBySessionId(sessionId);
    
      if (existingJob) {
        return {
          job: existingJob,
          created: false
        };
      }
    
      const job = await createJob({
        lessonId,
        sessionId,
        groupId,
        meetingTitle,
        metadata
      });
    
      return {
        job,
        created: true
      };
    }

  async function listJobs({
    status = null,
    sessionId = null,
    groupId = null
  } = {}) {
    let jobs = await readJobs();

    if (status) {
      jobs = jobs.filter(
        job => job.status === status
      );
    }

    if (sessionId) {
      jobs = jobs.filter(
        job => job.sessionId === sessionId
      );
    }

    if (groupId) {
      jobs = jobs.filter(
        job => job.groupId === groupId
      );
    }

    return clone(jobs);
  }

  async function updateJob(
    jobId,
    updates = {}
  ) {
    return withJobsQueue(async () => {
    if (!jobId) {
      throw new Error(
        "JobService.updateJob requires a jobId."
      );
    }

    const jobs = await readJobs();

    const index = jobs.findIndex(
      job => job.jobId === jobId
    );

    if (index < 0) {
      throw new Error(
        `Job not found: ${jobId}`
      );
    }

    const existingJob = jobs[index];

    /*
     * Protected fields cannot be replaced through
     * a general update.
     */
    const {
      jobId: ignoredJobId,
      createdAt: ignoredCreatedAt,
      ...safeUpdates
    } = updates;

    const updatedJob = {
      ...existingJob,
      ...safeUpdates,

      artifacts: {
        ...(existingJob.artifacts || {}),
        ...(safeUpdates.artifacts || {})
      },

      metadata: {
        ...(existingJob.metadata || {}),
        ...(safeUpdates.metadata || {})
      },

      jobId: existingJob.jobId,
      createdAt: existingJob.createdAt,
      updatedAt: nowIso()
    };

    jobs[index] = updatedJob;
    await writeJobs(jobs);

    return clone(updatedJob);
    });
  }

  async function startJob(
    jobId,
    step = JOB_STEP.TRANSCRIPTION
  ) {
    const timestamp = nowIso();

    return updateJob(jobId, {
      status: JOB_STATUS.PROCESSING,
      currentStep: step,
      startedAt: timestamp,
      completedAt: null,
      failedAt: null,
      error: null
    });
  }

  async function updateStep(
    jobId,
    step
  ) {
    const validSteps =
      Object.values(JOB_STEP);

    if (!validSteps.includes(step)) {
      throw new Error(
        `Invalid job step: ${step}`
      );
    }

    return updateJob(jobId, {
      status: JOB_STATUS.PROCESSING,
      currentStep: step,
      error: null
    });
  }

  async function addArtifact(
    jobId,
    artifactType,
    artifact
  ) {
    const validArtifactTypes = [
      "microphoneRecording",
      "tabRecording",
      "transcript",
      "summary",
      "homework"
    ];

    if (
      !validArtifactTypes.includes(
        artifactType
      )
    ) {
      throw new Error(
        `Invalid artifact type: ${artifactType}`
      );
    }

    return updateJob(jobId, {
      artifacts: {
        [artifactType]: artifact
      }
    });
  }

  async function failJob(
    jobId,
    error,
    step = null
  ) {
    const timestamp = nowIso();

    const errorMessage =
      error instanceof Error
        ? error.message
        : String(error || "Unknown job error");

    const updates = {
      status: JOB_STATUS.FAILED,
      failedAt: timestamp,
      completedAt: null,
      error: {
        message: errorMessage,
        occurredAt: timestamp
      }
    };

    if (step) {
      updates.currentStep = step;
    }

    return updateJob(jobId, updates);
  }

  async function completeJob(jobId) {
    const timestamp = nowIso();

    return updateJob(jobId, {
      status: JOB_STATUS.COMPLETED,
      currentStep: JOB_STEP.COMPLETE,
      completedAt: timestamp,
      failedAt: null,
      error: null
    });
  }

  async function deleteJob(jobId) {
    return withJobsQueue(async () => {
    if (!jobId) {
      throw new Error(
        "JobService.deleteJob requires a jobId."
      );
    }

    const jobs = await readJobs();

    const filteredJobs = jobs.filter(
      job => job.jobId !== jobId
    );

    if (
      filteredJobs.length === jobs.length
    ) {
      return {
        ok: false,
        reason: "JOB_NOT_FOUND"
      };
    }

    await writeJobs(filteredJobs);

    return {
      ok: true,
      jobId
    };
    });
  }

  return Object.freeze({
    JOB_STATUS,
    JOB_STEP,

    initialize,
    createJob,
    ensureJobForSession,
    getJob,
    getJobBySessionId,
    listJobs,
    updateJob,
    startJob,
    updateStep,
    addArtifact,
    failJob,
    completeJob,
    deleteJob
  });

})();