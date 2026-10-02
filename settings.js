const backButton = document.getElementById("backButton");
const cancelButton = document.getElementById("cancelButton");
const saveButton = document.getElementById("saveSettingsButton");

const transcriptionProvider = document.getElementById(
  "transcriptionProvider"
);

const deepgramApiKey = document.getElementById(
  "deepgramApiKey"
);

const assemblyAiApiKey = document.getElementById(
  "assemblyAiApiKey"
);

const deepgramApiKeyGroup = document.getElementById(
  "deepgramApiKeyGroup"
);

const assemblyAiApiKeyGroup = document.getElementById(
  "assemblyAiApiKeyGroup"
);

const recordingRetention = document.getElementById(
  "recordingRetention"
);

const recordingRetentionDescription = document.getElementById(
  "recordingRetentionDescription"
);

const microphonePermissionStatus = document.getElementById(
  "microphonePermissionStatus"
);

const grantMicrophoneButton = document.getElementById(
  "grantMicrophoneButton"
);

const settingsMessage = document.getElementById(
  "settingsMessage"
);

/**
 * Returns the user to the recorder popup.
 */
function goBack() {
  window.location.href = "popup.html";
}

/**
 * Displays a message beneath the settings cards.
 */
function showMessage(message, isError = false) {
  settingsMessage.textContent = message;
  settingsMessage.classList.toggle("error", isError);
}

/**
 * Updates the microphone permission badge and button.
 */
function updateMicrophonePermissionUI(state) {
  microphonePermissionStatus.classList.remove(
    "neutral",
    "success",
    "warning",
    "error"
  );

  if (state === "granted") {
    microphonePermissionStatus.textContent = "Granted";
    microphonePermissionStatus.classList.add("success");
    grantMicrophoneButton.hidden = true;
    return;
  }

  if (state === "denied") {
    microphonePermissionStatus.textContent = "Blocked";
    microphonePermissionStatus.classList.add("error");
    grantMicrophoneButton.hidden = false;
    grantMicrophoneButton.textContent = "Grant Permission";
    return;
  }

  if (state === "prompt") {
    microphonePermissionStatus.textContent =
      "Permission Required";

    microphonePermissionStatus.classList.add("warning");
    grantMicrophoneButton.hidden = false;
    grantMicrophoneButton.textContent = "Grant Permission";
    return;
  }

  microphonePermissionStatus.textContent = "Unknown";
  microphonePermissionStatus.classList.add("neutral");
  grantMicrophoneButton.hidden = false;
  grantMicrophoneButton.textContent = "Check Permission";
}

/**
 * Checks the browser's current microphone permission state
 * without opening the permission prompt.
 */
async function checkMicrophonePermission() {
  updateMicrophonePermissionUI("unknown");

  if (!navigator.permissions?.query) {
    updateMicrophonePermissionUI("unknown");
    return;
  }

  try {
    const permission = await navigator.permissions.query({
      name: "microphone"
    });

    updateMicrophonePermissionUI(permission.state);

    permission.addEventListener("change", () => {
      updateMicrophonePermissionUI(permission.state);
    });
  } catch (error) {
    console.warn(
      "Unable to check microphone permission:",
      error
    );

    updateMicrophonePermissionUI("unknown");
  }
}

/**
 * Requests microphone access following a direct user click.
 *
 * The temporary stream is stopped immediately because this
 * action is only used to obtain or verify permission.
 */
async function requestMicrophonePermission() {
  grantMicrophoneButton.disabled = true;
  grantMicrophoneButton.textContent = "Requesting...";

  let stream = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });

    await chrome.storage.local.set({
      microphoneSetupCompleted: true
    });

    updateMicrophonePermissionUI("granted");
    showMessage("✓ Microphone permission granted");
  } catch (error) {
    console.error(
      "Microphone permission request failed:",
      error
    );

    updateMicrophonePermissionUI("denied");

    if (error?.name === "NotAllowedError") {
      showMessage(
        "Microphone access was blocked. Allow microphone access in Chrome and try again.",
        true
      );
    } else if (error?.name === "NotFoundError") {
      showMessage(
        "No microphone was detected.",
        true
      );
    } else {
      showMessage(
        "TeachAssist could not access the microphone.",
        true
      );
    }
  } finally {
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
    }

    grantMicrophoneButton.disabled = false;
  }
}

/**
 * Shows only the API key for the selected provider.
 */
function updateApiKeyVisibility() {
  const provider = transcriptionProvider.value;

  deepgramApiKeyGroup.hidden =
    provider !== "deepgram";

  assemblyAiApiKeyGroup.hidden =
    provider !== "assemblyai";
}

/**
 * Updates the retention description to match the selected option.
 */
function updateRecordingRetentionDescription() {
  recordingRetentionDescription.textContent =
    recordingRetention.value === "keep_copy"
      ? "Save a copy of the recording to the user's Downloads folder while still removing TeachAssist's temporary recording after successful transcription."
      : "The recording is automatically deleted after the transcript has been successfully saved. This saves storage space and helps protect privacy.";
}

/**
 * Loads the saved recorder settings from Chrome storage.
 */
async function loadSettings() {
  try {
    const storedSettings =
      await chrome.storage.local.get({
        transcriptionProvider: "deepgram",
        deepgramApiKey: "",
        assemblyAiApiKey: "",
        recordingRetention: "delete"
      });

    transcriptionProvider.value =
      storedSettings.transcriptionProvider;
     
    updateApiKeyVisibility();

    deepgramApiKey.value =
      storedSettings.deepgramApiKey;

    assemblyAiApiKey.value =
      storedSettings.assemblyAiApiKey;

    recordingRetention.value =
      storedSettings.recordingRetention;

    updateRecordingRetentionDescription();
  } catch (error) {
    console.error(
      "Unable to load settings:",
      error
    );

    showMessage(
      "Settings could not be loaded.",
      true
    );
  }
}

/**
 * Saves transcription settings and API keys locally.
 */
async function saveSettings() {
  saveButton.disabled = true;
  cancelButton.disabled = true;

  showMessage("Saving settings...");

  try {
    await chrome.storage.local.set({
      transcriptionProvider:
        transcriptionProvider.value,

      deepgramApiKey:
        deepgramApiKey.value.trim(),

      assemblyAiApiKey:
        assemblyAiApiKey.value.trim(),

      recordingRetention:
        recordingRetention.value
    });

    showMessage("✓ Settings saved. Returning to recorder...");

    // Give the user time to see the confirmation
    setTimeout(() => {
      goBack();
    }, 600);

  } catch (error) {
    console.error(
      "Unable to save settings:",
      error
    );

    showMessage(
      "Settings could not be saved.",
      true
    );

    // Re-enable the buttons so the user can try again
    saveButton.disabled = false;
    cancelButton.disabled = false;
  }
}

/**
 * Connects the settings page buttons to their actions.
 */
backButton.addEventListener("click", goBack);
cancelButton.addEventListener("click", goBack);
saveButton.addEventListener("click", saveSettings);

grantMicrophoneButton.addEventListener(
  "click",
  requestMicrophonePermission
);

transcriptionProvider.addEventListener(
  "change",
  updateApiKeyVisibility
);

recordingRetention.addEventListener(
  "change",
  updateRecordingRetentionDescription
);

/**
 * Initializes the page after the HTML has loaded.
 */
async function initializeSettings() {
  await loadSettings();
  await checkMicrophonePermission();
}

initializeSettings();