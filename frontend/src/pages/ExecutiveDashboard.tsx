// src/pages/ExecutiveDashboard.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { runsApi } from "../api/runs";
import type { Run, RunStatus } from "../api/types";
import { ApiError } from "../api/client";

import { SlideOver } from "../components/SlideOver";
import { showToast } from "../components/Toast";

const POLL_IDLE_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS ?? 15000);
const POLL_ACTIVE_MS = Number(import.meta.env.VITE_POLL_FAST_INTERVAL_MS ?? 4000);

function errorToString(err: unknown) {
  if (!err) return "Unbekannter Fehler";
  if (err instanceof ApiError) {
    const body = typeof err.body === "string" ? err.body : JSON.stringify(err.body);
    return `API ${err.status}: ${body}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function fmtIso(s?: string | null) {
  if (!s) return "—";
  return s.replace("T", " ").replace("Z", " UTC");
}

function statusLabel(status: RunStatus | string) {
  switch (status) {
    case "queued":
      return "In Vorbereitung";
    case "running":
      return "Wird berechnet";
    case "success":
      return "Abgeschlossen";
    case "failed":
      return "Nicht erfolgreich";
    case "canceled":
      return "Abgebrochen";
    default:
      return String(status);
  }
}

function statusBadge(status: RunStatus | string) {
  if (status === "success") return { cls: "badge badge-success", text: statusLabel(status) };
  if (status === "failed") return { cls: "badge badge-danger", text: statusLabel(status) };
  if (status === "running") return { cls: "badge badge-warning", text: statusLabel(status) };
  return { cls: "badge", text: statusLabel(status) };
}

function countByStatus(runs: Run[]) {
  return runs.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    { queued: 0, running: 0, success: 0, failed: 0, canceled: 0 } as Record<string, number>,
  );
}

export default function ExecutiveDashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [softLoading, setSoftLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runsApiAvailable, setRunsApiAvailable] = useState(true);

  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [statusFilter, setStatusFilter] = useState<RunStatus | "all">((searchParams.get("status") as any) ?? "all");

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(true);

  const timerRef = useRef<number | null>(null);
  const pollingRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    pollingRef.current = isPolling;
  }, [isPolling]);

  const hasActiveRuns = useMemo(() => runs.some((r) => r.status === "queued" || r.status === "running"), [runs]);
  const pollMs = hasActiveRuns ? POLL_ACTIVE_MS : POLL_IDLE_MS;
  const statusCounts = useMemo(() => countByStatus(runs), [runs]);

  const filteredRuns = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!q) return true;
      return `${r.id} ${r.status} ${r.message ?? ""} ${(r as any).error ?? ""} ${(r as any).created_at ?? ""}`
        .toLowerCase()
        .includes(q);
    });
  }, [runs, query, statusFilter]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (query) next.set("q", query);
    if (statusFilter !== "all") next.set("status", statusFilter);
    setSearchParams(next, { replace: true });
  }, [query, statusFilter, setSearchParams]);

  // --- Runs API (optional) -------------------------------------------------

const fetchRuns = useCallback(
  async (reason: "initial" | "manual") => {
    // Wenn dein Backend kein /api/runs implementiert, tun wir so als sei es "nicht verfügbar"
    setLoadingRuns(true);
    setError(null);

    try {
      // optional: abort handling
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      const list = await runsApi.list({ signal: abortRef.current.signal });
      setRuns(list);
      setRunsApiAvailable(true);
    } catch (e) {
      const msg = errorToString(e);

      // 404 = Endpoint existiert nicht → kein UI-Fehler, sondern Feature deaktivieren
      if (msg.includes("404")) {
        setRunsApiAvailable(false);
        setRuns([]);       // optional: leeren
        setError(null);    // wichtig: keine Fehlermeldung anzeigen
      } else {
        setError(msg);
      }
    } finally {
      setLoadingRuns(false);
    }
  },
  []
);

// Beim Öffnen NICHT automatisch /api/runs laden
useEffect(() => {
  setRunsApiAvailable(false);
  return () => abortRef.current?.abort();
}, []);


  useEffect(() => {
  // Backend hat aktuell kein /api/runs → nicht automatisch laden
  setRunsApiAvailable(false);
  return () => abortRef.current?.abort();
}, []);

  useEffect(() => {
    if (!isPolling || !runsApiAvailable) {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      return;
    }

    let cancelled = false;

    const tick = async () => {
      if (cancelled || !pollingRef.current) return;
      await fetchRuns("refresh");
      if (cancelled || !pollingRef.current) return;
      timerRef.current = window.setTimeout(tick, pollMs);
    };

    timerRef.current = window.setTimeout(tick, pollMs);

    return () => {
      cancelled = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [fetchRuns, pollMs, isPolling, runsApiAvailable]);

  const createRun = async () => {
    try {
      setSoftLoading(true);
      const run = await runsApi.create({});
      showToast("Prognoseberechnung gestartet", "success");
      setSelectedRunId(run.id);
      await fetchRuns("refresh");
    } catch (e) {
      showToast(`Start fehlgeschlagen: ${errorToString(e)}`, "error");
    } finally {
      setSoftLoading(false);
    }
  };

  const openForecast = (runId: string) => {
    navigate(`/forecast?run_id=${encodeURIComponent(runId)}`);
  };

  const selectedRun = useMemo(() => runs.find((r) => r.id === selectedRunId) ?? null, [runs, selectedRunId]);

  return (
    <div className="page space-y-4">
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-extrabold">Prognoseübersicht</h1>
            <div className="text-sm text-secondary">
              Letztes Update: {lastUpdated ?? "—"} {softLoading ? "· Aktualisiere…" : ""}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={createRun} disabled={softLoading || !runsApiAvailable}>
              Neue Prognose berechnen
            </button>
            <button className="btn btn-secondary" onClick={() => fetchRuns("refresh")} disabled={softLoading || !runsApiAvailable}>
              Aktualisieren
            </button>
            <button className="btn btn-ghost" onClick={() => setIsPolling((p) => !p)} disabled={!runsApiAvailable}>
              {isPolling ? "Auto-Refresh pausieren" : "Auto-Refresh aktivieren"}
            </button>
          </div>
        </div>

        {!runsApiAvailable ? (
          <div className="mt-3 text-sm font-semibold text-secondary">
            Hinweis: Dein Backend liefert aktuell keine <span className="font-mono">/api/runs</span> Endpoints.
            Diese Seite ist deshalb deaktiviert. Nutze stattdessen direkt das Forecast-Dashboard.
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

      {error && <div className="card p-4 text-red-600">{error}</div>}

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="input w-72" placeholder="Suche…" value={query} onChange={(e) => setQuery(e.target.value)} disabled={!runsApiAvailable} />
          <select className="input w-56" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} disabled={!runsApiAvailable}>
            <option value="all">Alle Status</option>
            <option value="queued">In Vorbereitung</option>
            <option value="running">Wird berechnet</option>
            <option value="success">Abgeschlossen</option>
            <option value="failed">Nicht erfolgreich</option>
            <option value="canceled">Abgebrochen</option>
          </select>

          <button className="btn" onClick={() => navigate("/forecast")} title="Direkt Forecast öffnen">
            Forecast Dashboard öffnen
          </button>
        </div>

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
              {filteredRuns.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono text-xs">{r.id}</td>
                  <td>
                    <span className={statusBadge(r.status).cls}>{statusBadge(r.status).text}</span>
                  </td>
                  <td>{fmtIso((r as any).created_at)}</td>
                  <td>
                    <button className="btn btn-primary" disabled={r.status !== "success"} onClick={() => openForecast(r.id)}>
                      Prognose ansehen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <SlideOver open={!!selectedRunId} onClose={() => setSelectedRunId(null)} title="Run-Details">
        {selectedRun && (
          <div className="p-4 space-y-2">
            <div>ID: {selectedRun.id}</div>
            <div>Status: {statusLabel(selectedRun.status)}</div>
            <div>Erstellt: {fmtIso((selectedRun as any).created_at)}</div>
            <div>{selectedRun.message}</div>
          </div>
        )}
      </SlideOver>
    </div>
  );
}
