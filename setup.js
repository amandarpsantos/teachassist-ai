const microphonePermissionStatus = document.getElementById(
  "microphonePermissionStatus"
);

const grantMicrophoneButton = document.getElementById(
  "grantMicrophoneButton"
);

const setupMessage = document.getElementById(
  "setupMessage"
);

/**
 * Updates the microphone permission badge
 * and controls which buttons are visible.
 */
function updatePermissionUI(state) {
  microphonePermissionStatus.classList.remove(
    "neutral",
    "success",
    "warning",
    "error"
  );

  switch (state) {
    case "granted":
      microphonePermissionStatus.textContent = "Granted";
      microphonePermissionStatus.classList.add("success");

      grantMicrophoneButton.hidden = true;
      break;

    case "denied":
      microphonePermissionStatus.textContent = "Blocked";
      microphonePermissionStatus.classList.add("error");

      grantMicrophoneButton.hidden = false;
      break;

    case "prompt":
      microphonePermissionStatus.textContent =
        "Permission Required";

      microphonePermissionStatus.classList.add("warning");

      grantMicrophoneButton.hidden = false;
      break;

    default:
      microphonePermissionStatus.textContent = "Checking...";
      microphonePermissionStatus.classList.add("neutral");

      grantMicrophoneButton.hidden = false;
  }
}

/**
 * Displays a status message.
 */
function showMessage(message, isError = false) {
  setupMessage.textContent = message;

  setupMessage.style.color = isError
    ? "#ef4444"
    : "#cbd5e1";
}

/**
 * Saves setup completion and opens the recorder
 * after a short confirmation message.
 */
async function completeSetupAndOpenRecorder() {
  await chrome.storage.local.set({
    setupCompleted: true,
    setupCompletedAt: Date.now(),
    recorderVersion: chrome.runtime.getManifest().version
  });

  updatePermissionUI("granted");

  showMessage(
    "✓ Setup complete!\nYou can now close this tab and click the TeachAssist AI extension whenever you're ready."
  );
}

/**
 * Checks the current microphone permission state
 * without opening a permission prompt.
 */
async function checkPermission() {
  if (!navigator.permissions?.query) {
    updatePermissionUI("prompt");
    return;
  }

  try {
    const permission = await navigator.permissions.query({
      name: "microphone"
    });

    updatePermissionUI(permission.state);

    if (permission.state === "granted") {
      await completeSetupAndOpenRecorder();
      return;
    }

    permission.addEventListener("change", () => {
      updatePermissionUI(permission.state);
    });
  } catch (error) {
    console.warn(
      "Unable to check microphone permission:",
      error
    );

    updatePermissionUI("prompt");
  }
}

/**
 * Requests microphone access after the user clicks
 * the Grant Microphone Permission button.
 */
async function requestPermission() {
  grantMicrophoneButton.disabled = true;
  grantMicrophoneButton.textContent = "Requesting...";

  showMessage("Requesting microphone access...");

  let stream = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });

    await completeSetupAndOpenRecorder();
  } catch (error) {
    console.error(
      "Microphone permission request failed:",
      error
    );

    if (error?.name === "NotAllowedError") {
      updatePermissionUI("denied");

      showMessage(
        "Microphone access was blocked. Allow microphone access in Chrome and try again.",
        true
      );
    } else if (error?.name === "NotFoundError") {
      updatePermissionUI("prompt");

      showMessage(
        "No microphone was detected.",
        true
      );
    } else {
      updatePermissionUI("prompt");

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
    grantMicrophoneButton.textContent =
      "Grant Microphone Permission";
  }
}

grantMicrophoneButton.addEventListener(
  "click",
  requestPermission
);

checkPermission();