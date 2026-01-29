import { forecastCopy } from "../lib/forecastCopy";

export type Variant = keyof typeof forecastCopy.empty;

export function ForecastEmptyState({
  variant,
  details,
}: {
  variant: Variant;
  details?: string;
}) {
  const content = forecastCopy.empty[variant];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="text-sm font-extrabold tracking-tight text-slate-900">{content.title}</div>

      <p className="mt-2 text-sm font-medium leading-6 text-slate-600">{content.body}</p>

      {details && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Technische Details</div>
          <pre className="mt-2 whitespace-pre-wrap text-xs font-medium text-slate-600">{details}</pre>
        </div>
      )}
    </div>
  );
}
