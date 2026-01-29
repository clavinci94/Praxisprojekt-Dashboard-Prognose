import { useEffect } from "react";

interface SlideOverProps {
  title: string;
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export function SlideOver({ title, isOpen, onClose, children }: SlideOverProps) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 h-full w-full bg-slate-900/40 backdrop-blur-[1px]"
      />

      {/* Panel */}
      <div className="absolute right-0 top-0 h-full w-full sm:w-[520px]">
        <div className="flex h-full flex-col bg-white shadow-2xl ring-1 ring-slate-200">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <div>
              <div className="text-sm font-extrabold tracking-tight text-slate-900">
                {title}
              </div>
              <div className="mt-0.5 text-xs font-medium text-slate-500">
                Details
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              aria-label="Close"
              title="Close"
            >
              <span className="text-lg leading-none">×</span>
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

          {/* Footer */}
          <div className="border-t border-slate-200 bg-slate-50 px-5 py-4">
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
