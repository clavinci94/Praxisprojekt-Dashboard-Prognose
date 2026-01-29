import { useEffect, useMemo, useState } from "react";

export type ToastType = "success" | "error" | "info";

export interface ToastMsg {
  id: number;
  message: string;
  type: ToastType;
}

export const toastEvent = new EventTarget();

export function showToast(message: string, type: ToastType = "info") {
  const event = new CustomEvent("add-toast", { detail: { message, type } });
  toastEvent.dispatchEvent(event);
}

function toastClasses(type: ToastType) {
  const base =
    "pointer-events-auto flex items-start gap-3 rounded-2xl border px-3 py-2 shadow-lg";
  if (type === "success") return `${base} border-emerald-200 bg-emerald-50 text-emerald-900`;
  if (type === "error") return `${base} border-rose-200 bg-rose-50 text-rose-900`;
  return `${base} border-slate-200 bg-white text-slate-900`;
}

function badgeClasses(type: ToastType) {
  const base =
    "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ring-inset";
  if (type === "success") return `${base} bg-emerald-100 text-emerald-800 ring-emerald-200`;
  if (type === "error") return `${base} bg-rose-100 text-rose-800 ring-rose-200`;
  return `${base} bg-slate-100 text-slate-700 ring-slate-200`;
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message: string; type: ToastType };
      const id = Date.now();

      setToasts((prev) => [...prev, { id, ...detail }]);

      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3500);
    };

    toastEvent.addEventListener("add-toast", handler);
    return () => toastEvent.removeEventListener("add-toast", handler);
  }, []);

  const hasToasts = toasts.length > 0;

  return (
    <div
      className={[
        "pointer-events-none fixed right-4 top-4 z-[60] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2",
        hasToasts ? "opacity-100" : "opacity-100",
      ].join(" ")}
      aria-live="polite"
      aria-relevant="additions"
    >
      {toasts.map((t) => (
        <div key={t.id} className={toastClasses(t.type)}>
          <div className="mt-0.5">
            <span className={badgeClasses(t.type)}>
              {t.type.toUpperCase()}
            </span>
          </div>

          <div className="flex-1">
            <div className="text-sm font-semibold leading-5">{t.message}</div>
          </div>

          <button
            type="button"
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white/70 text-slate-700 hover:bg-white"
            aria-label="Dismiss"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
