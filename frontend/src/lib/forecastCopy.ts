// Forecasting/src/lib/forecastCopy.ts

export const forecastCopy = {
  kpis: {
    next4IsoWeeks: "Next 4 ISO weeks",
  },

  empty: {
    forecasting: {
      title: "Forecast is being prepared",
      body:
        "We are computing the latest forecast. This usually takes only a few seconds. The view will refresh automatically.",
    },
    noData: {
      title: "No data available",
      body:
        "No historical data was found for this dataset. Please check that the CSV exists and contains rows.",
    },
    failed: {
      title: "Forecast run failed",
      body:
        "The last forecast run did not complete successfully. Please check the run details or retry.",
    },
  },
};
