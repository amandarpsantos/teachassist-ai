const recordButton = document.getElementById("recordButton");
const recordingStatus = document.getElementById("recordingStatus");
const meetingStatus = document.getElementById("meetingStatus");
const microphoneStatus = document.getElementById("microphoneStatus");
const dashboardButton = document.getElementById("dashboardButton");
const settingsButton = document.getElementById("settingsButton");
const closeButton = document.getElementById("closeButton");

let popupState = {
  isMeeting: false,
  isRecording: false,
  platform: null,
  microphone: "unknown"
};

let activeTabPlatform = null;

init();

async function init() {
  const { setupCompleted } =
    await chrome.storage.local.get("setupCompleted");

  if (!setupCompleted) {
    chrome.tabs.create({
      url: chrome.runtime.getURL("setup.html")
    });

    window.close();
    return;
  }

  await refreshState();

  recordButton.addEventListener("click", toggleRecording);

  dashboardButton.addEventListener("click", () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL("dashboard/index.html")
    });
  });

  settingsButton.addEventListener("click", () => {
    window.location.href = "settings.html";
  });

  closeButton.addEventListener("click", () => {
    window.close();
  });
}

/**
 * Reads Chrome's microphone permission.
 */
async function getMicrophonePermissionState() {
  if (!navigator.permissions?.query) {
    return "unknown";
  }

  try {
    const permission = await navigator.permissions.query({
      name: "microphone"
    });

    return permission.state;
  } catch (error) {
    console.warn(
      "Unable to check microphone permission:",
      error
    );

    return "unknown";
  }
}

async function refreshState() {
  const microphonePermission =
    await getMicrophonePermissionState();

  const tabStatus = await chrome.runtime.sendMessage({
    type: "TA_GET_ACTIVE_TAB_STATUS"
  });

  activeTabPlatform = tabStatus?.platform || null;
  popupState.isMeeting = Boolean(tabStatus?.isMeeting);

  // No meeting open
  if (!popupState.isMeeting) {
    popupState = {
      isMeeting: false,
      isRecording: false,
      platform: null,
      microphone: microphonePermission
    };

    render();
    return;
  }

  const contentState =
    await chrome.runtime.sendMessage({
      type: "TA_POPUP_GET_CONTENT_STATE"
    });

  if (contentState?.ok) {
    popupState = {
      isMeeting: Boolean(contentState.isMeeting),
      isRecording: Boolean(contentState.isRecording),
      platform:
        contentState.platform ||
        activeTabPlatform ||
        "Meeting",

      microphone:
        contentState.microphone ||
        microphonePermission
    };
  } else {
    popupState = {
      isMeeting: false,
      isRecording: false,
      platform: null,
      microphone: microphonePermission
    };
  }

  render();
}

async function toggleRecording() {
  if (!popupState.isMeeting) return;

  recordButton.disabled = true;

  await chrome.runtime.sendMessage({
    type: "TA_POPUP_TOGGLE_RECORDING"
  });

  await refreshState();

  recordButton.disabled = false;
}

function render() {
  if (!popupState.isMeeting) {
    recordButton.textContent = "No Active Meeting";
    recordButton.className = "record-button";
    recordButton.disabled = true;

    setStatus(
      recordingStatus,
      "Ready",
      "ok"
    );

    setStatus(
      meetingStatus,
      "No Active Meeting",
      "error"
    );

    switch (popupState.microphone) {
      case "granted":
        setStatus(
          microphoneStatus,
          "Granted ✓",
          "ok"
        );
        break;

      case "denied":
        setStatus(
          microphoneStatus,
          "Blocked",
          "error"
        );
        break;

      case "prompt":
        setStatus(
          microphoneStatus,
          "Permission Required",
          "error"
        );
        break;

      default:
        setStatus(
          microphoneStatus,
          "Permission Unknown",
          ""
        );
    }

    return;
  }

  recordButton.disabled = false;

  recordButton.textContent =
    popupState.isRecording
      ? "Stop Recording"
      : "Start Recording";

  recordButton.className =
    popupState.isRecording
      ? "record-button stop"
      : "record-button start";

  setStatus(
    recordingStatus,
    popupState.isRecording
      ? "Recording"
      : "Ready",
    popupState.isRecording
      ? "error"
      : "ok"
  );

  setStatus(
    meetingStatus,
    popupState.platform || "Meeting",
    "ok"
  );

  setStatus(
    microphoneStatus,
    popupState.microphone === "granted"
      ? "Granted ✓"
      : popupState.microphone,
    popupState.microphone === "granted"
      ? "ok"
      : ""
  );
}

function setStatus(element, text, className) {
  element.textContent = text;
  element.className =
    `status-value ${className || ""}`.trim();
}