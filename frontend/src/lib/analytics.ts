import * as amplitude from "@amplitude/analytics-browser";

export function initAnalytics() {
  if (!import.meta.env.PROD) {
    // lokal komplett aus
    amplitude.setOptOut(true);
    return;
  }

  amplitude.init(import.meta.env.VITE_AMPLITUDE_KEY, {
    defaultTracking: {
      pageViews: true,
      sessions: true,
      fileDownloads: false,
      formInteractions: false,
    },
  });
}
