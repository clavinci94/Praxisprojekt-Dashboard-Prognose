# APE / Outlier Regeln (Forecasting UI)

Diese Regeln dokumentieren die aktuelle Logik ohne API-Änderung.

## 1) APE-Berechnung (Daily Errors)

- `error = forecast - actual`
- `abs_error = abs(error)`
- `APE = abs_error / abs(actual)` **nur wenn** `abs(actual) >= ape_denominator_floor`
- Falls `abs(actual) < ape_denominator_floor`, dann ist `APE = null` (UI zeigt `—`)

### Dynamischer `ape_denominator_floor`

- Aus den Non-Zero-Actuals im Backtest-Fenster:
  - `median_nonzero_actual * 0.01`
  - mindestens `1.0`
- Zweck: Prozentfehler bei sehr kleinen Mengen (nahe 0) nicht künstlich explodieren zu lassen.

## 2) Metriken

- `MAPE`: Mittelwert der gültigen APE-Werte
- `sMAPE = 2 * abs_error / (abs(actual) + abs(forecast))`
- `WAPE = sum(abs_error) / sum(actual)`
- `Bias = sum(error) / sum(actual)`

## 3) Outlier-Fallback (Ranking)

1. primär: `APE` (wenn vorhanden)
2. fallback: `abs_error` (wenn `APE` nicht verfügbar)
3. Tie-Breaker: größere `abs_error`, dann Datum

Damit bleibt das Outlier-Ranking stabil und reproduzierbar.

## 4) Frontend-Hinweis

- APE kann bei kleinen/Null-Ist-Werten `null` sein
- Outlier-Logik nutzt dieselbe Priorität (APE -> abs_error)
- Bestehende API-Felder/Prop-Verträge bleiben unverändert
