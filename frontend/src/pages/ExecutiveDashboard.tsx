import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { runsApi } from "../api/runs";
import type { Run, RunStatus } from "../api/types";
import { ApiError } from "../api/client";
import { SlideOver } from "../components/SlideOver";
import { showToast } from "../components/Toast";

function errorToString(err: unknown) {
  if (!err) return "Unbekannter Fehler";
  if (err instanceof ApiError) {
    const body = typeof err.body === "string" ? err.body : JSON.stringify(err.body);
    return `API ${err.status}: ${body}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function statusLabel(status: RunStatus | string) {
  if (status === "queued") return "In Vorbereitung";
  if (status === "running") return "Wird berechnet";
  if (status === "success") return "Abgeschlossen";
  if (status === "failed") return "Nicht erfolgreich";
  if (status === "canceled") return "Abgebrochen";
  return String(status);
}

function statusBadge(status: RunStatus | string) {
  if (status === "success") return { cls: "badge badge-success", text: statusLabel(status) };
  if (status === "failed") return { cls: "badge badge-danger", text: statusLabel(status) };
  if (status === "running") return { cls: "badge badge-warning", text: statusLabel(status) };
  return { cls: "badge", text: statusLabel(status) };
}

function fmtIso(s?: string | null) {
  if (!s) return "—";
  return s.replace("T", " ").replace("Z", " UTC");
}

export default function ExecutiveDashboard() {
  const navigate = useNavigate();

  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runsApiAvailable, setRunsApiAvailable] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const refreshRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await runsApi.list();
      setRuns(list);
      setRunsApiAvailable(true);
    } catch (err) {
      const msg = errorToString(err);
      if (msg.includes("404")) {
        setRunsApiAvailable(false);
        setRuns([]);
        setError(null);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  const statusCounts = useMemo(() => {
    return runs.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      },
      { queued: 0, running: 0, success: 0, failed: 0, canceled: 0 } as Record<string, number>,
    );
  }, [runs]);

  const selectedRun = useMemo(() => runs.find((r) => r.id === selectedRunId) ?? null, [runs, selectedRunId]);

  async function createRun() {
    try {
      const run = await runsApi.create({});
      showToast("Prognoseberechnung gestartet", "success");
      setSelectedRunId(run.id);
      await refreshRuns();
    } catch (err) {
      showToast(`Start fehlgeschlagen: ${errorToString(err)}`, "error");
    }
  }

  return (
    <div className="page space-y-4">
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-extrabold">Prognoseübersicht</h1>
            <div className="text-sm text-secondary">Runs verwalten und Forecast öffnen</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={createRun} disabled={!runsApiAvailable}>
              Neue Prognose berechnen
            </button>
            <button className="btn btn-secondary" onClick={refreshRuns} disabled={!runsApiAvailable}>
              Aktualisieren
            </button>
            <button className="btn" onClick={() => navigate("/forecast")}>
              Forecast Dashboard öffnen
            </button>
          </div>
        </div>

        {!runsApiAvailable ? (
          <div className="mt-3 text-sm font-semibold text-secondary">
            Hinweis: Dein Backend stellt aktuell keine <span className="font-mono">/api/runs</span>-Endpoints bereit.
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="kpi">Gesamt: {runs.length}</div>
        <div className="kpi">Queued: {statusCounts.queued}</div>
        <div className="kpi">Running: {statusCounts.running}</div>
        <div className="kpi">Success: {statusCounts.success}</div>
        <div className="kpi">Failed: {statusCounts.failed}</div>
      </div>

      {error ? <div className="card p-4 text-red-600">{error}</div> : null}

      <div className="card p-4">
        {!runsApiAvailable ? (
          <div className="text-sm font-semibold text-secondary">
            Keine Runs verfügbar (Backend bietet <span className="font-mono">/api/runs</span> nicht an).
          </div>
        ) : loading ? (
          <div className="text-sm font-semibold text-secondary">Lade Runs…</div>
        ) : (
          <table className="min-w-full">
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Erstellt</th>
                <th>Aktion</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono text-xs">{r.id}</td>
                  <td>
                    <span className={statusBadge(r.status).cls}>{statusBadge(r.status).text}</span>
                  </td>
                  <td>{fmtIso((r as any).created_at)}</td>
                  <td className="flex gap-2">
                    <button className="btn" onClick={() => setSelectedRunId(r.id)}>
                      Details
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={r.status !== "success"}
                      onClick={() => navigate(`/forecast?run_id=${encodeURIComponent(r.id)}`)}
                    >
                      Prognose ansehen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <SlideOver isOpen={!!selectedRunId} onClose={() => setSelectedRunId(null)} title="Run-Details">
        {selectedRun ? (
          <div className="space-y-2">
            <div>ID: {selectedRun.id}</div>
            <div>Status: {statusLabel(selectedRun.status)}</div>
            <div>Erstellt: {fmtIso((selectedRun as any).created_at)}</div>
            {selectedRun.message ? <div>Message: {selectedRun.message}</div> : null}
          </div>
        ) : null}
      </SlideOver>
    </div>
  );
}
