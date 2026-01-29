// Forecasting/src/pages/RunTable.tsx
import type { CSSProperties } from "react";
import type { Run } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";


export function RunTable({
  runs,
  onSelect,
}: {
  runs: Run[];
  onSelect: (id: string) => void;
}) {
  const hasRuns = runs.length > 0;

  // simple “sales-friendly” empty messaging
  const emptyTitle = "No forecast runs yet";
  const emptyBody =
    "As soon as a forecast run is triggered, it will appear here with status and timestamps.";

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        background: "var(--surface)",
      }}
    >
      <div style={{ overflow: "auto", maxHeight: 520 }}>
        <table>
          <thead>
            <tr>
              <th style={thId}>Run ID</th>
              <th style={th}>Status</th>
              <th style={th}>Created</th>
              <th style={th}>Started</th>
              <th style={th}>Finished</th>
              <th style={th}>Message</th>
            </tr>
          </thead>

          <tbody>
            {runs.map((r) => (
              <tr
                key={r.id}
                onClick={() => onSelect(r.id)}
                style={{ cursor: "pointer" }}
                title="Click to select"
              >
                <td style={tdMono}>{r.id}</td>

                <td style={td}>
                  <StatusBadge status={r.status} />
                </td>

                <td style={td}>{fmt(r.created_at)}</td>
                <td style={td}>{fmt(r.started_at)}</td>
                <td style={td}>{fmt((r as any).finished_at)}</td>

                <td style={td}>
                  {r.status === "failed" ? (
                    <span title={(r as any).error ?? ""}>
                      {truncate((r as any).error) || "Failed — open for details"}
                    </span>
                  ) : (
                    <span title={r.message ?? ""}>
                      {truncate(r.message) ||
                        (r.status === "running"
                          ? "Forecast is running…"
                          : r.status === "queued"
                            ? "Queued — waiting to start"
                            : "")}
                    </span>
                  )}
                </td>
              </tr>
            ))}

            {!hasRuns && (
              <tr>
                <td style={{ padding: 16 }} colSpan={6}>
                  <div style={{ fontWeight: 650, marginBottom: 6 }}>
                    {emptyTitle}
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 13 }}>
                    {emptyBody}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--muted)",
  whiteSpace: "nowrap",
};

const thId: CSSProperties = { ...th, width: 260 };

const td: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  fontSize: 13,
  verticalAlign: "top",
  color: "var(--text)",
};

const tdMono: CSSProperties = {
  ...td,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 12,
  color: "rgba(255,255,255,0.88)",
};

function truncate(s?: string | null, n = 120) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function fmt(s?: string | null) {
  if (!s) return "-";
  return s.replace("T", " ").replace("Z", " UTC");
}
