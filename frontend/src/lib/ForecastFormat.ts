// Forecasting/src/lib/forecastFormat.ts

export function getForecastUnit(data: any): string {
  // preferred: backend liefert es irgendwann
  if (data?.kpis?.unit) return data.kpis.unit;

  // fallback für awb_weight
  return "kg";
}

export function getModelLabel(data: any): string {
  const model = data?.run?.model;
  if (!model) return "Baseline model";

  return model
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c: string) => c.toUpperCase());
}
