# Forecasting UI - Praxisprojekt Dashboard Prognose

Dieses Projekt ist ein Full-Stack Forecasting-Dashboard fuer eingehende/ausgehende Luftfracht-Daten.
Es kombiniert ein FastAPI-Backend (Daten, Forecast, KPI/Fehler-Metriken) mit einem React+TypeScript-Frontend
fuer eine PowerBI-aehnliche Visualisierung.

## Was das Projekt macht

- Forecast pro Datenstrom (unabhängig voneinander) mit gemeinsamer Zielgroesse `sum_weight`
- Datensaetze:
  - `export`
  - `import`
  - `tra_export`
  - `tra_import` (Transit Import)
- KPI/Qualitaetsmetriken: WAPE, MAPE, Bias, Daily Errors, Outlier-Tage
- Dashboard mit:
  - Forecast vs Actual
  - Unsicherheitsband (p05/p95)
  - Abweichungen und Outlier
  - Proxy-Kennzahlen für operative Einsparpotenziale

## Projektstruktur

```text
.
├── backend
│   ├── src/app
│   │   ├── api            # FastAPI Router + Endpoints
│   │   ├── ml             # XGBoost Forecasting
│   │   ├── services       # CSV Loader, Dataset Mapping
│   │   └── main.py        # App Entry
│   └── models             # XGBoost Modell-Dateien
├── frontend
│   ├── src/pages          # Dashboards und Seiten
│   ├── src/hooks          # Datenaggregation fuer Frontend
│   └── vite.config.ts     # Proxy /api -> backend:8080
└── scripts
```

## Datenbasis / CSV Anforderungen

Im Datenverzeichnis muessen diese 4 Dateien liegen:

- `cl_export.csv`
- `cl_import.csv`
- `cl_tra_export.csv`
- `cl_tra_import.csv`

Wichtig:

- Zielwert ist immer `sum_weight` (mit Fallback auf kompatible Gewichtsspalten).
- Zeitspalten je Dataset:
  - `import` -> `fl_gmt_arrival_date`
  - `tra_import` -> `am_action_date` (bewusst so gesetzt, fuer realistische Forecasts)
  - `export` -> `fl_gmt_departure_date`
  - `tra_export` -> `fl_gmt_departure_date`

## Lokal starten (Quickstart)

### 1) Voraussetzungen

- Python 3.11+
- Node.js 18+ (npm inklusive)

### 2) Backend konfigurieren

Setze in `backend/.env`:

```env
CARGOLOGIC_DATA_DIR="/Pfad/zu/deinen/CSV"
```

### 3) Python-Abhaengigkeiten installieren

Im Projekt-Root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e backend
pip install pandas
```

Hinweis: `pandas` wird im Code benötigt.

### 4) Frontend-Abhängigkeiten installieren

```bash
cd frontend
npm install
```

### 5) Entwicklungsserver starten

Terminal 1 (Backend):

```bash
cd backend
python -m uvicorn app.main:app --app-dir src --host 127.0.0.1 --port 8080 --reload
```

Terminal 2 (Frontend):

```bash
cd frontend
npm run dev
```

Danach im Browser:

- Frontend: `http://localhost:5173`
- Backend API: `http://127.0.0.1:8080/api/...`

## Alternative: Frontend + Backend mit einem Befehl

Im Frontend:

```bash
npm run dev:all
```

Hinweis: `dev:all` setzt aktuell einen festen `CARGOLOGIC_DATA_DIR` in `frontend/package.json`.
Passe ihn bei Bedarf auf deinen lokalen Pfad an.

## Modelle neu trainieren

Alle 4 XGBoost Modelle neu trainieren:

```bash
PYTHONPATH=backend/src CARGOLOGIC_DATA_DIR="/Pfad/zu/deinen/CSV" python -m app.ml.xgb_pipeline
```

Modelle werden nach `backend/models` geschrieben.

## Wichtige API Endpoints

- `GET /api/datasets` - erkannte Datensaetze
- `POST /api/series/{dataset_key}` - Actual + Forecast (inkl. optionaler Quantile)
- `POST /api/forecast/{model_key}` - Forecast only (Legacy/Fallback Pfad)
- `POST /api/metrics/{model_key}` - KPI/Metriken fuer Live-Modus
- `GET /api/metrics/runs/{run_id}` - KPI/Metriken fuer Run-Modus
- `GET /api/runs` / `POST /api/runs` - Run Verwaltung

## Typische Fehlerbehebung

### `ECONNREFUSED 127.0.0.1:8080` im Frontend

Backend läuft nicht oder auf falschem Port.
Starte Backend auf `127.0.0.1:8080`.

### `500` auf `/api/datasets` oder `/api/series/...`

Meistens ist `CARGOLOGIC_DATA_DIR` falsch oder CSV-Dateien fehlen.
Pruefe Dateinamen und Pfad.

### `No module named pandas`

`pip install pandas` im aktiven venv ausfuehren.

### Transit Import Forecast wirkt unplausibel

`tra_import` nutzt absichtlich `am_action_date`.
Nach Daten-/Schemaänderungen Modell neu trainieren.

## Hinweise zur Nutzung im Dashboard

- Tritt eine ungewöhnlich hohe Abweichung auf, zuerst Daily Errors + Outlier Tabelle prüfen.
- Für Planning/Operations:
  - `p50` = Standardplanung
  - `p95` = konservativer Kapazitaetsfall
- Weekly und Daily Sicht sind beide verfügbar (je nach Ansicht/Chart).

