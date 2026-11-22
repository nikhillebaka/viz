"""
Tests for CalendarSpec (MMWR vs ISO, 52/53-week years, horizon_offset_days, season modes)
and GeoGraph (FIPS, MetroCast HSAs + statewide 'All', legacy NYC/TX, CSV-free RespiCast Europe,
and anti-double-counting pool resolution).
"""

from datetime import date
from pathlib import Path
import shutil
import tempfile
import unittest

import polars as pl

import conftest  # noqa: F401
from viz.core.calendar import CalendarSpec, infer_calendar
from viz.core.data_loader import date_to_season_and_week
from viz.core.geo import build_geo_graph


class TestCalendarSpec(unittest.TestCase):
    def test_mmwr_parity_across_52_and_53_week_years(self):
        cal = CalendarSpec(week_system="mmwr", season_mode="respiratory_nh", season_start_week=31)
        # 2020 has 53 MMWR weeks, 2025 has 53 MMWR weeks
        sample_dates = [
            "2020-01-01", "2020-08-01", "2020-08-08", "2020-12-30", "2021-01-02",
            "2021-01-03", "2024-08-03", "2025-01-04", "2025-07-26", "2025-08-02",
            "2026-01-03", "2026-01-10", "2026-08-01",
        ]
        for d in sample_dates:
            s_legacy, w_legacy = date_to_season_and_week(d)
            yr = int(s_legacy.split("/")[0])
            expected_s = f"{yr}-{yr + 1}"
            s_cal, w_cal = cal.date_to_season_and_week(d)
            self.assertEqual((s_cal, w_cal), (expected_s, w_legacy), f"mismatch on {d}")

        bounds = cal.season_bounds("2025-2026")
        self.assertEqual(bounds[0], "2025-07-27")
        self.assertEqual(cal.prev_season("2025-2026"), "2024-2025")

    def test_respicast_wednesday_origin_sunday_target_inference(self):
        tasks = {
            "rounds": [{
                "round_id": "origin_date",
                "model_tasks": [{
                    "task_ids": {
                        "origin_date": {"required": ["2025-11-05", "2025-11-12"]},
                        "target": {"required": ["ILI incidence"]},
                        "horizon": {"required": [1, 2, 3, 4]},
                        "target_end_date": {"required": ["2025-11-09", "2025-11-16", "2025-11-23", "2025-11-30"]},
                    },
                    "output_type": {"quantile": {}},
                }],
            }]
        }
        cal = infer_calendar(tasks, targets=["ILI incidence"])
        self.assertEqual(cal.week_system, "iso")
        self.assertEqual(cal.round_id_col, "origin_date")
        self.assertEqual(cal.round_day_of_week, 2)   # Wednesday
        self.assertEqual(cal.target_day_of_week, 6)  # Sunday
        self.assertEqual(cal.horizon_offset_days, -3)
        self.assertEqual(cal.derive_horizon("2025-11-05", "2025-11-09"), 1)
        self.assertEqual(cal.derive_horizon("2025-11-05", "2025-11-30"), 4)
        self.assertEqual(cal.target_end_date_for("2025-11-12", 1), "2025-11-16")

    def test_year_round_covid_inference(self):
        tasks = {
            "rounds": [{
                "model_tasks": [{
                    "task_ids": {
                        "reference_date": {"optional": ["2024-11-16", "2025-07-05"]},
                        "target": {"required": ["wk inc covid hosp"]},
                        "horizon": {"optional": [0, 1, 2, 3]},
                    },
                    "output_type": {"quantile": {}},
                }]
            }]
        }
        cal = infer_calendar(tasks, targets=["wk inc covid hosp"])
        self.assertEqual(cal.active_months, tuple(range(1, 13)))
        self.assertEqual(cal.horizon_offset_days, 0)


class TestGeoGraph(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_flusight_fips_and_padding(self):
        csv_path = self.tmp / "locations.csv"
        pl.DataFrame({
            "abbreviation": ["US", "AL", "CA", "MA"],
            "location": ["US", "01", "06", "25"],
            "location_name": ["United States", "Alabama", "California", "Massachusetts"],
            "population": [334_000_000, 5_100_000, 38_900_000, 7_000_000],
        }).write_csv(csv_path)
        geo = build_geo_graph(csv_path)
        self.assertTrue(geo.uses_us_fips)
        self.assertEqual(geo.normalize_location_id("1"), "01")
        self.assertEqual(geo.default_location(), "US")
        self.assertEqual(geo.aggregate_locations_in_scope(), {"US"})
        self.assertEqual(set(geo.resolve_pool("all")), {"01", "06", "25"})
        self.assertEqual(geo.resolve_pool("aggregates"), ["US"])

    def test_metrocast_all_statewide_and_legacy_nyc_anti_double_counting(self):
        csv_path = self.tmp / "locations.csv"
        pl.DataFrame({
            "location": ["utah", "provo", "salt-lake-city", "nyc", "Bronx", "Kings"],
            "location_name": ["Utah", "Provo", "Salt Lake City", "NYC", "Bronx", "Kings"],
            "abbreviation": ["UT", "provo", "SLC", "NYC", "Bronx", "Kings"],
            "population": [3_400_000, 115_000, 200_000, 8_300_000, 1_400_000, 2_500_000],
            "original_location_code": ["All", "397", "345", "All", "NYC-Bronx", "NYC-Kings"],
            "location_type": ["hsa_nci_id"] * 6,
            "state_abb": ["UT", "UT", "UT", "NY", "NY", "NY"],
            "state_name": ["Utah", "Utah", "Utah", "New York", "New York", "New York"],
        }).write_csv(csv_path)
        geo = build_geo_graph(csv_path)
        self.assertFalse(geo.uses_us_fips)
        self.assertEqual(geo.aggregate_locations_in_scope(), {"utah", "nyc"})
        self.assertEqual(set(geo.resolve_pool("all")), {"provo", "salt-lake-city", "Bronx", "Kings"})
        self.assertEqual(set(geo.resolve_pool("aggregates")), {"utah", "nyc"})
        # When querying a slice containing ONLY utah and no UT children, utah is NOT an aggregate in that slice
        self.assertEqual(geo.aggregate_locations_in_scope(active_ids=["utah", "provo"]), {"utah"})
        self.assertEqual(geo.aggregate_locations_in_scope(active_ids=["utah", "Bronx"]), set())

    def test_respicast_no_locations_csv_fallback_to_gazetteer(self):
        tasks = {
            "rounds": [{
                "model_tasks": [{
                    "task_ids": {
                        "location": {"optional": ["DE", "FR", "GB", "GB-ENG", "IT"]},
                        "target": {"required": ["ILI incidence"]},
                    },
                    "output_type": {"quantile": {}},
                }]
            }]
        }
        geo = build_geo_graph(None, tasks_config=tasks, fallback_us=True)
        self.assertNotIn("US", geo.nodes)
        self.assertEqual(geo.nodes["DE"].name, "Germany")
        # GB is parent of GB-ENG
        self.assertEqual(geo.aggregate_locations_in_scope(), {"GB"})
        self.assertEqual(set(geo.resolve_pool("all")), {"DE", "FR", "GB-ENG", "IT"})
        self.assertEqual(geo.default_location(), "DE")


if __name__ == "__main__":
    unittest.main()
