import type { RunStatus } from "../api/types";

const STYLES: Record<
  RunStatus,
  { label: string; bg: string; fg: string; bd: string }
> = {
  queued: {
    label: "Queued",
    bg: "rgba(100,116,139,0.12)",
    fg: "rgb(100,116,139)",
    bd: "rgba(100,116,139,0.35)",
  },
  running: {
    label: "Running",
    bg: "rgba(37,99,235,0.12)",
    fg: "rgb(37,99,235)",
    bd: "rgba(37,99,235,0.35)",
  },
  success: {
    label: "Success",
    bg: "rgba(22,163,74,0.12)",
    fg: "rgb(22,163,74)",
    bd: "rgba(22,163,74,0.35)",
  },
  failed: {
    label: "Failed",
    bg: "rgba(220,38,38,0.12)",
    fg: "rgb(220,38,38)",
    bd: "rgba(220,38,38,0.35)",
  },
  canceled: {
    label: "Canceled",
    bg: "rgba(249,115,22,0.12)",
    fg: "rgb(249,115,22)",
    bd: "rgba(249,115,22,0.35)",
  },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const s = STYLES[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 10px",
        borderRadius: 999,
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.bd}`,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: "18px",
        whiteSpace: "nowrap",
      }}
      title={s.label}
    >
      {s.label}
    </span>
  );
}
