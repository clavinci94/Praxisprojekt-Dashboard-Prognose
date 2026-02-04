from __future__ import annotations

import unittest
from datetime import date
from unittest.mock import patch

import pandas as pd

from app.api.routes.metrics import (
    _ape_floor,
    _compute_ape,
    _outlier_score,
    compute_naive_backtest_metrics,
    DailyErrorPoint,
)


class MetricsRulesTest(unittest.TestCase):
    def test_ape_floor_handles_all_zero(self) -> None:
        self.assertEqual(_ape_floor([0.0, 0.0, 0.0]), 1.0)

    def test_ape_floor_uses_median_fraction(self) -> None:
        # non-zero sorted => [100, 200], upper median = 200 => floor = 2.0
        self.assertEqual(_ape_floor([0.0, 100.0, 200.0]), 2.0)

    def test_compute_ape_respects_floor(self) -> None:
        self.assertIsNone(_compute_ape(abs_error=10.0, actual=0.5, denominator_floor=1.0))
        self.assertEqual(_compute_ape(abs_error=10.0, actual=2.0, denominator_floor=1.0), 5.0)

    def test_outlier_score_prefers_ape(self) -> None:
        with_ape = DailyErrorPoint(
            date="2025-01-01",
            actual=100.0,
            forecast=120.0,
            error=20.0,
            abs_error=20.0,
            ape=0.2,
        )
        no_ape = DailyErrorPoint(
            date="2025-01-02",
            actual=0.0,
            forecast=50.0,
            error=50.0,
            abs_error=50.0,
            ape=None,
        )
        self.assertEqual(_outlier_score(with_ape), 0.2)
        self.assertEqual(_outlier_score(no_ape), 50.0)

    @patch("app.api.routes.metrics._predict_model_backtest")
    def test_outliers_sorted_with_ape_then_abs_error(self, mock_predict) -> None:
        # Build a tiny daily series with a known 5-day backtest window.
        idx = pd.date_range("2025-01-01", periods=10, freq="D")
        vals = [10.0, 10.0, 10.0, 10.0, 10.0, 100.0, 0.0, 100.0, 50.0, 1.0]
        series = pd.Series(vals, index=idx)

        # Window is 2025-01-06..2025-01-10 (5 days)
        # Forecasts are chosen to create:
        # - one huge APE day (actual=1, forecast=50)
        # - one APE=1.0 day
        # - one ape=None day (actual=0) that must fallback to abs_error
        mock_predict.return_value = ([200.0, 40.0, 90.0, 10.0, 50.0], "xgb_walk_forward_1d", None)

        res = compute_naive_backtest_metrics(
            model_key="export",
            start_date=date(2025, 1, 11),
            series=series,
            backtest_days=5,
            include_daily_errors=True,
            daily_errors_limit=3,
            outliers_only=True,
        )

        self.assertEqual(res.metrics["method"], "xgb_walk_forward_1d")
        self.assertEqual(len(res.daily_errors), 3)
        # Top outlier should be 2025-01-10 (actual=1, forecast=50 => APE=49)
        self.assertEqual(res.daily_errors[0].date, "2025-01-10")


if __name__ == "__main__":
    unittest.main()
