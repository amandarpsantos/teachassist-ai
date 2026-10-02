/**
 * TeachAssist AI — Meeting Service
 *
 * Identifies supported meeting tabs and normalizes meeting metadata.
 *
 * This service does not:
 * - start or stop recordings
 * - create lessons
 * - save artifacts
 * - manage icons
 * - manage pipeline state
 */

const MeetingService = (() => {
  const PLATFORMS = Object.freeze({
    GOOGLE_MEET: "Google Meet",
    MICROSOFT_TEAMS: "Microsoft Teams"
  });

  const MEETING_PATTERNS = Object.freeze([
    {
      platform: PLATFORMS.GOOGLE_MEET,
      pattern: /^https:\/\/meet\.google\.com\//
    },
    {
      platform: PLATFORMS.MICROSOFT_TEAMS,
      pattern: /^https:\/\/teams\.microsoft\.com\//
    },
    {
      platform: PLATFORMS.MICROSOFT_TEAMS,
      pattern: /^https:\/\/teams\.live\.com\//
    }
  ]);

  /**
   * Returns true when the URL belongs to a supported meeting platform.
   */
  function isSupportedMeetingUrl(url = "") {
    if (typeof url !== "string") {
      return false;
    }

    return MEETING_PATTERNS.some(
      ({ pattern }) => pattern.test(url)
    );
  }

  /**
   * Returns the platform name for a supported URL.
   */
  function getPlatformFromUrl(url = "") {
    if (typeof url !== "string") {
      return null;
    }

    const match = MEETING_PATTERNS.find(
      ({ pattern }) => pattern.test(url)
    );

    return match?.platform || null;
  }

  /**
   * Returns the active tab in the current Chrome window.
   */
  async function getActiveTab() {
    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    return tabs[0] || null;
  }

  /**
   * Requests meeting information from the content script.
   *
   * Failure is allowed. MeetingService can fall back to tab metadata.
   */
  async function getPageMeetingState(tabId) {
    if (!Number.isInteger(tabId)) {
      return null;
    }

    try {
      const response =
        await chrome.tabs.sendMessage(
          tabId,
          {
            type: "TA_GET_STATE"
          }
        );

      return response || null;
    } catch {
      return null;
    }
  }

  /**
   * Builds a normalized meeting object from a Chrome tab.
   */
  async function getMeetingInfoFromTab(tab) {
    const url =
      typeof tab?.url === "string"
        ? tab.url
        : "";

    const platform =
      getPlatformFromUrl(url);

    const supportedUrl =
      isSupportedMeetingUrl(url);

    if (!tab?.id || !supportedUrl) {
      return createEmptyMeetingInfo({
        tabId: tab?.id || null,
        tabTitle: tab?.title || null,
        url
      });
    }

    const pageState =
      await getPageMeetingState(tab.id);

    const isMeeting =
      Boolean(
        pageState?.ok &&
        pageState?.isMeeting
      );

    const rawMeetingTitle =
      firstNonEmptyString([
        pageState?.meetingTitle,
        pageState?.title,
        pageState?.classTitle,
        tab.title
      ]);

    const meetingTitle =
      normalizeMeetingTitle(
        rawMeetingTitle,
        platform
      );

    return {
      isSupportedUrl: true,
      isMeeting,

      platform:
        pageState?.platform ||
        platform,

      meetingTitle,

      studentName:
        normalizeOptionalString(
          pageState?.studentName
        ),

      classProgram:
        normalizeOptionalString(
          pageState?.classProgram
        ),

      meetingUrl: url,

      tabId: tab.id,

      tabTitle:
        normalizeOptionalString(
          tab.title
        ),

      source:
        pageState?.ok
          ? "page"
          : "tab"
    };
  }

  /**
   * Returns information about the active browser tab.
   */
  async function getCurrentMeeting() {
    const tab =
      await getActiveTab();

    return getMeetingInfoFromTab(tab);
  }

  /**
   * Removes platform-generated text from a tab or meeting title.
   */
  function normalizeMeetingTitle(
    title,
    platform = null
  ) {
    const normalized =
      normalizeOptionalString(title);

    if (!normalized) {
      return null;
    }

    let result = normalized;

    const removableParts = [
      "Google Meet",
      "Microsoft Teams",
      "Meeting | Microsoft Teams",
      "| Microsoft Teams",
      "- Google Meet"
    ];

    for (
      const removablePart of
      removableParts
    ) {
      result = result.replace(
        removablePart,
        ""
      );
    }

    if (platform) {
      result = result.replace(
        platform,
        ""
      );
    }

    result = result
      .replace(/\s+/g, " ")
      .replace(/^[\s|\-–—:]+/, "")
      .replace(/[\s|\-–—:]+$/, "")
      .trim();

    return result || null;
  }

  /**
   * Creates the standard response shape for unsupported or missing tabs.
   */
  function createEmptyMeetingInfo({
    tabId = null,
    tabTitle = null,
    url = ""
  } = {}) {
    return {
      isSupportedUrl: false,
      isMeeting: false,

      platform: null,
      meetingTitle: null,
      studentName: null,
      classProgram: null,
      meetingUrl: url || null,

      tabId,
      tabTitle:
        normalizeOptionalString(
          tabTitle
        ),

      source: null
    };
  }

  function firstNonEmptyString(
    values = []
  ) {
    for (const value of values) {
      const normalized =
        normalizeOptionalString(value);

      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  function normalizeOptionalString(
    value
  ) {
    if (
      typeof value !== "string"
    ) {
      return null;
    }

    const normalized =
      value
        .replace(/\s+/g, " ")
        .trim();

    return normalized || null;
  }

  return Object.freeze({
    PLATFORMS,

    isSupportedMeetingUrl,
    getPlatformFromUrl,

    getActiveTab,
    getMeetingInfoFromTab,
    getCurrentMeeting,

    normalizeMeetingTitle
  });
})();