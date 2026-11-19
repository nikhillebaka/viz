"""
Universal Geographic Graph, built-in reference gazetteer, and principled anti-double-counting
pooling for Hubverse forecast hubs.

Supports without hardcoding:
- US FIPS national + states/territories (`01`..`78`, `US`) with HHS regions and centroids
- Sub-state hierarchies (`flu-metrocast` HSAs, CA regions, NC regions, UT regions, statewide `All`
  rows, legacy 2024-25 NYC boroughs + TX cities)
- European / ISO-3166-1 & ISO-3166-2 jurisdictions (`RespiCast`: AT..SK + GB-ENG/WLS/NIR/SCT) even
  when a hub repository ships without `auxiliary-data/locations.csv`
- Dynamic aggregate detection per active slice (`primary` leaves vs `aggregates` ancestors, plus
  `level:<lvl>` and `region:<reg>` cohorts) so evaluations never double-count parent totals with
  constituent sub-jurisdictions.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import logging
from pathlib import Path
import re
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import polars as pl

logger = logging.getLogger("viz.geo")

NULL_VALUES = ["", "NA", "null", "NaN", "None", "NULL"]

# US Department of Health and Human Services (HHS) 10 Public Health Regions
HHS_REGIONS: Dict[int, Dict[str, Any]] = {
    1: {"name": "Region 1 (New England)", "short": "New England", "states": ["CT", "ME", "MA", "NH", "RI", "VT"]},
    2: {"name": "Region 2 (New York & NJ)", "short": "New York & NJ", "states": ["NJ", "NY", "PR", "VI"]},
    3: {"name": "Region 3 (Mid-Atlantic)", "short": "Mid-Atlantic", "states": ["DE", "DC", "MD", "PA", "VA", "WV"]},
    4: {"name": "Region 4 (Southeast)", "short": "Southeast", "states": ["AL", "FL", "GA", "KY", "MS", "NC", "SC", "TN"]},
    5: {"name": "Region 5 (Great Lakes)", "short": "Great Lakes", "states": ["IL", "IN", "MI", "MN", "OH", "WI"]},
    6: {"name": "Region 6 (South Central)", "short": "South Central", "states": ["AR", "LA", "NM", "OK", "TX"]},
    7: {"name": "Region 7 (Central)", "short": "Central", "states": ["IA", "KS", "MO", "NE"]},
    8: {"name": "Region 8 (Mountain)", "short": "Mountain", "states": ["CO", "MT", "ND", "SD", "UT", "WY"]},
    9: {"name": "Region 9 (Pacific Southwest)", "short": "Pacific SW", "states": ["AZ", "CA", "HI", "NV", "AS", "GU", "MP"]},
    10: {"name": "Region 10 (Pacific Northwest)", "short": "Pacific NW", "states": ["AK", "ID", "OR", "WA"]},
}

STATE_TO_HHS_REGION: Dict[str, int] = {
    st: r_id for r_id, r_info in HHS_REGIONS.items() for st in r_info["states"]
}

# Built-in US national + state/territory reference (population ~2020-2023 Census, centroids deg)
US_STATES_REF: Dict[str, Dict[str, Any]] = {
    "US": {"abbr": "US", "name": "United States", "level": "country", "parent_id": None, "region": "National", "population": 334_914_895, "lat": 39.83, "lon": -98.58},
    "01": {"abbr": "AL", "name": "Alabama", "level": "state", "parent_id": "US", "population": 5_108_468, "lat": 32.78, "lon": -86.83},
    "02": {"abbr": "AK", "name": "Alaska", "level": "state", "parent_id": "US", "population": 733_406, "lat": 64.07, "lon": -152.28},
    "04": {"abbr": "AZ", "name": "Arizona", "level": "state", "parent_id": "US", "population": 7_431_344, "lat": 34.27, "lon": -111.66},
    "05": {"abbr": "AR", "name": "Arkansas", "level": "state", "parent_id": "US", "population": 3_067_732, "lat": 34.89, "lon": -92.44},
    "06": {"abbr": "CA", "name": "California", "level": "state", "parent_id": "US", "population": 38_965_193, "lat": 37.18, "lon": -119.47},
    "08": {"abbr": "CO", "name": "Colorado", "level": "state", "parent_id": "US", "population": 5_877_610, "lat": 38.99, "lon": -105.55},
    "09": {"abbr": "CT", "name": "Connecticut", "level": "state", "parent_id": "US", "population": 3_617_176, "lat": 41.62, "lon": -72.73},
    "10": {"abbr": "DE", "name": "Delaware", "level": "state", "parent_id": "US", "population": 1_031_890, "lat": 38.99, "lon": -75.51},
    "11": {"abbr": "DC", "name": "District of Columbia", "level": "state", "parent_id": "US", "population": 678_972, "lat": 38.91, "lon": -77.01},
    "12": {"abbr": "FL", "name": "Florida", "level": "state", "parent_id": "US", "population": 22_610_726, "lat": 28.63, "lon": -82.45},
    "13": {"abbr": "GA", "name": "Georgia", "level": "state", "parent_id": "US", "population": 11_029_227, "lat": 32.64, "lon": -83.44},
    "15": {"abbr": "HI", "name": "Hawaii", "level": "state", "parent_id": "US", "population": 1_435_138, "lat": 20.29, "lon": -156.37},
    "16": {"abbr": "ID", "name": "Idaho", "level": "state", "parent_id": "US", "population": 1_964_726, "lat": 44.35, "lon": -114.61},
    "17": {"abbr": "IL", "name": "Illinois", "level": "state", "parent_id": "US", "population": 12_549_689, "lat": 40.04, "lon": -89.20},
    "18": {"abbr": "IN", "name": "Indiana", "level": "state", "parent_id": "US", "population": 6_862_199, "lat": 39.89, "lon": -86.28},
    "19": {"abbr": "IA", "name": "Iowa", "level": "state", "parent_id": "US", "population": 3_207_004, "lat": 42.08, "lon": -93.50},
    "20": {"abbr": "KS", "name": "Kansas", "level": "state", "parent_id": "US", "population": 2_940_546, "lat": 38.49, "lon": -98.38},
    "21": {"abbr": "KY", "name": "Kentucky", "level": "state", "parent_id": "US", "population": 4_526_154, "lat": 37.53, "lon": -85.30},
    "22": {"abbr": "LA", "name": "Louisiana", "level": "state", "parent_id": "US", "population": 4_573_749, "lat": 31.07, "lon": -92.00},
    "23": {"abbr": "ME", "name": "Maine", "level": "state", "parent_id": "US", "population": 1_395_722, "lat": 45.37, "lon": -69.24},
    "24": {"abbr": "MD", "name": "Maryland", "level": "state", "parent_id": "US", "population": 6_180_253, "lat": 39.05, "lon": -76.79},
    "25": {"abbr": "MA", "name": "Massachusetts", "level": "state", "parent_id": "US", "population": 7_001_399, "lat": 42.26, "lon": -71.81},
    "26": {"abbr": "MI", "name": "Michigan", "level": "state", "parent_id": "US", "population": 10_037_261, "lat": 44.35, "lon": -85.41},
    "27": {"abbr": "MN", "name": "Minnesota", "level": "state", "parent_id": "US", "population": 5_737_915, "lat": 46.28, "lon": -94.31},
    "28": {"abbr": "MS", "name": "Mississippi", "level": "state", "parent_id": "US", "population": 2_939_690, "lat": 32.74, "lon": -89.67},
    "29": {"abbr": "MO", "name": "Missouri", "level": "state", "parent_id": "US", "population": 6_196_156, "lat": 38.36, "lon": -92.46},
    "30": {"abbr": "MT", "name": "Montana", "level": "state", "parent_id": "US", "population": 1_132_812, "lat": 47.05, "lon": -109.63},
    "31": {"abbr": "NE", "name": "Nebraska", "level": "state", "parent_id": "US", "population": 1_978_379, "lat": 41.54, "lon": -99.80},
    "32": {"abbr": "NV", "name": "Nevada", "level": "state", "parent_id": "US", "population": 3_194_176, "lat": 39.33, "lon": -116.63},
    "33": {"abbr": "NH", "name": "New Hampshire", "level": "state", "parent_id": "US", "population": 1_402_054, "lat": 43.68, "lon": -71.58},
    "34": {"abbr": "NJ", "name": "New Jersey", "level": "state", "parent_id": "US", "population": 9_290_841, "lat": 40.19, "lon": -74.67},
    "35": {"abbr": "NM", "name": "New Mexico", "level": "state", "parent_id": "US", "population": 2_114_371, "lat": 34.41, "lon": -106.11},
    "36": {"abbr": "NY", "name": "New York", "level": "state", "parent_id": "US", "population": 19_571_216, "lat": 42.95, "lon": -75.53},
    "37": {"abbr": "NC", "name": "North Carolina", "level": "state", "parent_id": "US", "population": 10_835_491, "lat": 35.56, "lon": -79.39},
    "38": {"abbr": "ND", "name": "North Dakota", "level": "state", "parent_id": "US", "population": 783_926, "lat": 47.45, "lon": -100.47},
    "39": {"abbr": "OH", "name": "Ohio", "level": "state", "parent_id": "US", "population": 11_785_935, "lat": 40.29, "lon": -82.79},
    "40": {"abbr": "OK", "name": "Oklahoma", "level": "state", "parent_id": "US", "population": 4_053_824, "lat": 35.59, "lon": -97.49},
    "41": {"abbr": "OR", "name": "Oregon", "level": "state", "parent_id": "US", "population": 4_233_358, "lat": 43.93, "lon": -120.56},
    "42": {"abbr": "PA", "name": "Pennsylvania", "level": "state", "parent_id": "US", "population": 12_961_683, "lat": 40.88, "lon": -77.80},
    "44": {"abbr": "RI", "name": "Rhode Island", "level": "state", "parent_id": "US", "population": 1_095_962, "lat": 41.68, "lon": -71.56},
    "45": {"abbr": "SC", "name": "South Carolina", "level": "state", "parent_id": "US", "population": 5_373_555, "lat": 33.92, "lon": -80.90},
    "46": {"abbr": "SD", "name": "South Dakota", "level": "state", "parent_id": "US", "population": 919_318, "lat": 44.44, "lon": -100.23},
    "47": {"abbr": "TN", "name": "Tennessee", "level": "state", "parent_id": "US", "population": 7_126_489, "lat": 35.86, "lon": -86.35},
    "48": {"abbr": "TX", "name": "Texas", "level": "state", "parent_id": "US", "population": 30_503_301, "lat": 31.48, "lon": -99.33},
    "49": {"abbr": "UT", "name": "Utah", "level": "state", "parent_id": "US", "population": 3_417_734, "lat": 39.31, "lon": -111.67},
    "50": {"abbr": "VT", "name": "Vermont", "level": "state", "parent_id": "US", "population": 647_464, "lat": 44.07, "lon": -72.67},
    "51": {"abbr": "VA", "name": "Virginia", "level": "state", "parent_id": "US", "population": 8_715_698, "lat": 37.52, "lon": -78.85},
    "53": {"abbr": "WA", "name": "Washington", "level": "state", "parent_id": "US", "population": 7_812_880, "lat": 47.38, "lon": -120.45},
    "54": {"abbr": "WV", "name": "West Virginia", "level": "state", "parent_id": "US", "population": 1_770_071, "lat": 38.64, "lon": -80.62},
    "55": {"abbr": "WI", "name": "Wisconsin", "level": "state", "parent_id": "US", "population": 5_910_955, "lat": 44.62, "lon": -89.99},
    "56": {"abbr": "WY", "name": "Wyoming", "level": "state", "parent_id": "US", "population": 584_057, "lat": 43.00, "lon": -107.55},
    "60": {"abbr": "AS", "name": "American Samoa", "level": "territory", "parent_id": "US", "population": 43_895, "lat": -14.31, "lon": -170.70},
    "66": {"abbr": "GU", "name": "Guam", "level": "territory", "parent_id": "US", "population": 166_506, "lat": 13.44, "lon": 144.79},
    "69": {"abbr": "MP", "name": "Northern Mariana Islands", "level": "territory", "parent_id": "US", "population": 45_143, "lat": 15.18, "lon": 145.75},
    "72": {"abbr": "PR", "name": "Puerto Rico", "level": "territory", "parent_id": "US", "population": 3_205_691, "lat": 18.22, "lon": -66.59},
    "78": {"abbr": "VI", "name": "U.S. Virgin Islands", "level": "territory", "parent_id": "US", "population": 87_146, "lat": 18.34, "lon": -64.90},
}
for _fips, _info in US_STATES_REF.items():
    if "region" not in _info and _info["abbr"] in STATE_TO_HHS_REGION:
        _info["region"] = f"HHS-{STATE_TO_HHS_REGION[_info['abbr']]}"

US_ABBR_TO_FIPS: Dict[str, str] = {info["abbr"]: fips for fips, info in US_STATES_REF.items() if fips != "US"}
US_NAME_TO_FIPS: Dict[str, str] = {info["name"].lower(): fips for fips, info in US_STATES_REF.items() if fips != "US"}

# Built-in European EEA / EU / UK reference table (for RespiCast & European hubs without locations.csv)
EUROPE_REF: Dict[str, Dict[str, Any]] = {
    "AT": {"abbr": "AT", "name": "Austria", "level": "country", "region": "Western Europe", "population": 9_158_750, "lat": 47.52, "lon": 14.55},
    "BE": {"abbr": "BE", "name": "Belgium", "level": "country", "region": "Western Europe", "population": 11_825_551, "lat": 50.50, "lon": 4.47},
    "BG": {"abbr": "BG", "name": "Bulgaria", "level": "country", "region": "Eastern Europe", "population": 6_445_481, "lat": 42.73, "lon": 25.49},
    "CH": {"abbr": "CH", "name": "Switzerland", "level": "country", "region": "Western Europe", "population": 8_962_300, "lat": 46.82, "lon": 8.23},
    "CY": {"abbr": "CY", "name": "Cyprus", "level": "country", "region": "Southern Europe", "population": 933_505, "lat": 35.13, "lon": 33.43},
    "CZ": {"abbr": "CZ", "name": "Czechia", "level": "country", "region": "Eastern Europe", "population": 10_900_555, "lat": 49.82, "lon": 15.47},
    "DE": {"abbr": "DE", "name": "Germany", "level": "country", "region": "Western Europe", "population": 83_445_000, "lat": 51.17, "lon": 10.45},
    "DK": {"abbr": "DK", "name": "Denmark", "level": "country", "region": "Northern Europe", "population": 5_961_249, "lat": 56.26, "lon": 9.50},
    "EE": {"abbr": "EE", "name": "Estonia", "level": "country", "region": "Northern Europe", "population": 1_374_687, "lat": 58.60, "lon": 25.01},
    "ES": {"abbr": "ES", "name": "Spain", "level": "country", "region": "Southern Europe", "population": 48_619_695, "lat": 40.46, "lon": -3.75},
    "FI": {"abbr": "FI", "name": "Finland", "level": "country", "region": "Northern Europe", "population": 5_603_851, "lat": 61.92, "lon": 25.75},
    "FR": {"abbr": "FR", "name": "France", "level": "country", "region": "Western Europe", "population": 68_373_433, "lat": 46.23, "lon": 2.21},
    "GB": {"abbr": "GB", "name": "United Kingdom", "level": "country", "region": "Northern Europe", "population": 68_265_209, "lat": 54.00, "lon": -2.50},
    "GB-ENG": {"abbr": "ENG", "name": "England", "level": "nation", "region": "Northern Europe", "population": 57_690_300, "lat": 52.36, "lon": -1.17, "parent_id": "GB"},
    "GB-NIR": {"abbr": "NIR", "name": "Northern Ireland", "level": "nation", "region": "Northern Europe", "population": 1_920_400, "lat": 54.79, "lon": -6.49, "parent_id": "GB"},
    "GB-SCT": {"abbr": "SCT", "name": "Scotland", "level": "nation", "region": "Northern Europe", "population": 5_490_100, "lat": 56.49, "lon": -4.20, "parent_id": "GB"},
    "GB-WLS": {"abbr": "WLS", "name": "Wales", "level": "nation", "region": "Northern Europe", "population": 3_164_400, "lat": 52.13, "lon": -3.78, "parent_id": "GB"},
    "GR": {"abbr": "GR", "name": "Greece", "level": "country", "region": "Southern Europe", "population": 10_397_193, "lat": 39.07, "lon": 21.82},
    "HR": {"abbr": "HR", "name": "Croatia", "level": "country", "region": "Southern Europe", "population": 3_861_967, "lat": 45.10, "lon": 15.20},
    "HU": {"abbr": "HU", "name": "Hungary", "level": "country", "region": "Eastern Europe", "population": 9_584_627, "lat": 47.16, "lon": 19.50},
    "IE": {"abbr": "IE", "name": "Ireland", "level": "country", "region": "Northern Europe", "population": 5_351_681, "lat": 53.14, "lon": -7.69},
    "IS": {"abbr": "IS", "name": "Iceland", "level": "country", "region": "Northern Europe", "population": 383_726, "lat": 64.96, "lon": -19.02},
    "IT": {"abbr": "IT", "name": "Italy", "level": "country", "region": "Southern Europe", "population": 58_989_749, "lat": 41.87, "lon": 12.57},
    "LI": {"abbr": "LI", "name": "Liechtenstein", "level": "country", "region": "Western Europe", "population": 40_023, "lat": 47.17, "lon": 9.56},
    "LT": {"abbr": "LT", "name": "Lithuania", "level": "country", "region": "Northern Europe", "population": 2_885_891, "lat": 55.17, "lon": 23.88},
    "LU": {"abbr": "LU", "name": "Luxembourg", "level": "country", "region": "Western Europe", "population": 672_050, "lat": 49.82, "lon": 6.13},
    "LV": {"abbr": "LV", "name": "Latvia", "level": "country", "region": "Northern Europe", "population": 1_871_882, "lat": 56.88, "lon": 24.60},
    "MT": {"abbr": "MT", "name": "Malta", "level": "country", "region": "Southern Europe", "population": 563_443, "lat": 35.94, "lon": 14.38},
    "NL": {"abbr": "NL", "name": "Netherlands", "level": "country", "region": "Western Europe", "population": 17_942_942, "lat": 52.13, "lon": 5.29},
    "NO": {"abbr": "NO", "name": "Norway", "level": "country", "region": "Northern Europe", "population": 5_550_203, "lat": 60.47, "lon": 8.47},
    "PL": {"abbr": "PL", "name": "Poland", "level": "country", "region": "Eastern Europe", "population": 36_620_970, "lat": 51.92, "lon": 19.15},
    "PT": {"abbr": "PT", "name": "Portugal", "level": "country", "region": "Southern Europe", "population": 10_639_726, "lat": 39.40, "lon": -8.22},
    "RO": {"abbr": "RO", "name": "Romania", "level": "country", "region": "Eastern Europe", "population": 19_064_409, "lat": 45.94, "lon": 24.97},
    "SE": {"abbr": "SE", "name": "Sweden", "level": "country", "region": "Northern Europe", "population": 10_551_707, "lat": 60.13, "lon": 18.64},
    "SI": {"abbr": "SI", "name": "Slovenia", "level": "country", "region": "Southern Europe", "population": 2_123_949, "lat": 46.15, "lon": 14.99},
    "SK": {"abbr": "SK", "name": "Slovakia", "level": "country", "region": "Eastern Europe", "population": 5_424_687, "lat": 48.67, "lon": 19.70},
    "UA": {"abbr": "UA", "name": "Ukraine", "level": "country", "region": "Eastern Europe", "population": 37_000_000, "lat": 48.38, "lon": 31.17},
}

# Known historical / MetroCast city & borough metadata when not repeated in current locations.csv
_LEGACY_US_SUBNATIONAL_REF: Dict[str, Dict[str, Any]] = {
    "NYC": {"abbr": "NYC", "name": "New York City", "level": "metro", "region": "NY", "state_abb": "NY", "lat": 40.71, "lon": -74.01, "is_hub_aggregate": True},
    "nyc": {"abbr": "NYC", "name": "New York City", "level": "metro", "region": "NY", "state_abb": "NY", "parent_hint": "new-york", "lat": 40.71, "lon": -74.01},
    "Bronx": {"abbr": "BX", "name": "Bronx, NY", "level": "borough", "region": "NY", "state_abb": "NY", "parent_hint": "NYC", "lat": 40.85, "lon": -73.87},
    "Brooklyn": {"abbr": "BK", "name": "Brooklyn, NY", "level": "borough", "region": "NY", "state_abb": "NY", "parent_hint": "NYC", "lat": 40.68, "lon": -73.94},
    "Manhattan": {"abbr": "MN", "name": "Manhattan, NY", "level": "borough", "region": "NY", "state_abb": "NY", "parent_hint": "NYC", "lat": 40.78, "lon": -73.97},
    "Queens": {"abbr": "QN", "name": "Queens, NY", "level": "borough", "region": "NY", "state_abb": "NY", "parent_hint": "NYC", "lat": 40.73, "lon": -73.79},
    "Staten Island": {"abbr": "SI", "name": "Staten Island, NY", "level": "borough", "region": "NY", "state_abb": "NY", "parent_hint": "NYC", "lat": 40.58, "lon": -74.15},
    "Austin": {"abbr": "Austin", "name": "Austin, TX", "level": "hsa", "region": "TX", "state_abb": "TX", "parent_hint": "texas", "lat": 30.27, "lon": -97.74},
    "Houston": {"abbr": "Houston", "name": "Houston, TX", "level": "hsa", "region": "TX", "state_abb": "TX", "parent_hint": "texas", "lat": 29.76, "lon": -95.37},
    "Dallas": {"abbr": "Dallas", "name": "Dallas, TX", "level": "hsa", "region": "TX", "state_abb": "TX", "parent_hint": "texas", "lat": 32.78, "lon": -96.80},
    "El Paso": {"abbr": "El Paso", "name": "El Paso, TX", "level": "hsa", "region": "TX", "state_abb": "TX", "parent_hint": "texas", "lat": 31.76, "lon": -106.49},
    "San Antonio": {"abbr": "San Antonio", "name": "San Antonio, TX", "level": "hsa", "region": "TX", "state_abb": "TX", "parent_hint": "texas", "lat": 29.42, "lon": -98.49},
    "provo": {"abbr": "Provo", "name": "Provo, UT", "level": "hsa", "region": "UT", "state_abb": "UT", "parent_hint": "utah", "lat": 40.23, "lon": -111.66},
    "salt-lake-city": {"abbr": "Salt Lake", "name": "Salt Lake City, UT", "level": "hsa", "region": "UT", "state_abb": "UT", "parent_hint": "utah", "lat": 40.76, "lon": -111.89},
    "ogden": {"abbr": "Ogden", "name": "Ogden, UT", "level": "hsa", "region": "UT", "state_abb": "UT", "parent_hint": "utah", "lat": 41.22, "lon": -111.97},
}


def _short_substate_abbr(loc_id: str, name: str, state_abb: Optional[str]) -> str:
    clean = re.sub(r",\s*[A-Z]{2}$", "", (name or "").strip())
    if clean and len(clean) <= 14:
        return clean
    if state_abb and len(loc_id) <= 14:
        return loc_id.replace("-", " ").title()
    return (clean or loc_id)[:16]


def _canonical_us_state(state_abb: Optional[str], state_name: Optional[str]) -> Optional[str]:
    if state_abb and state_abb.upper() in US_ABBR_TO_FIPS:
        return f"US:{US_ABBR_TO_FIPS[state_abb.upper()]}"
    if state_name and state_name.strip().lower() in US_NAME_TO_FIPS:
        return f"US:{US_NAME_TO_FIPS[state_name.strip().lower()]}"
    return None


@dataclass
class GeoNode:
    id: str
    canonical_id: str
    abbr: str
    name: str
    level: str = "custom"  # country | state | nation | metro | region | hsa | borough | territory | custom
    parent_id: Optional[str] = None
    region: Optional[str] = None
    population: Optional[int] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    counties: Optional[List[str]] = None
    is_hub_aggregate: bool = False

    def to_legacy_dict(self, *, is_aggregate: bool = False) -> Dict[str, Any]:
        return {
            "id": self.id,
            "canonical_id": self.canonical_id,
            "abbreviation": self.abbr,
            "abbr": self.abbr,
            "name": self.name,
            "level": self.level,
            "parent_id": self.parent_id,
            "region": self.region,
            "population": self.population,
            "lat": self.lat,
            "lon": self.lon,
            "counties": self.counties,
            "is_aggregate": is_aggregate,
        }


class GeoGraph:
    """
    Hub geographic hierarchy graph & principled anti-double-counting pooling resolver.
    """

    def __init__(self, nodes: Dict[str, GeoNode], uses_us_fips: bool = False):
        self.nodes: Dict[str, GeoNode] = dict(nodes)
        self.uses_us_fips: bool = bool(uses_us_fips)
        self._ancestors_cache: Dict[str, Set[str]] = {}

    def normalize_location_id(self, raw: Any) -> str:
        s = str(raw if raw is not None else "").strip()
        if self.uses_us_fips and len(s) == 1 and s.isdigit():
            return f"0{s}"
        return s

    def _ancestors(self, loc_id: str) -> Set[str]:
        cached = self._ancestors_cache.get(loc_id)
        if cached is not None:
            return cached
        anc: Set[str] = set()
        cur = self.nodes.get(loc_id)
        seen = {loc_id}
        while cur is not None and cur.parent_id and cur.parent_id not in seen:
            anc.add(cur.parent_id)
            seen.add(cur.parent_id)
            cur = self.nodes.get(cur.parent_id)
        self._ancestors_cache[loc_id] = anc
        return anc

    def aggregate_locations_in_scope(self, active_ids: Optional[Iterable[str]] = None) -> Set[str]:
        """
        Return the set of locations in `active_ids` that act as aggregates (ancestors of >= 1 other
        active location in the same slice). Prevents double-counting parent totals with leaves.
        """
        scope = set(active_ids) if active_ids is not None else set(self.nodes.keys())
        if len(scope) <= 1:
            return set()
        aggs: Set[str] = set()
        for loc in scope:
            aggs.update(self._ancestors(loc) & scope)
        # Safety net for FIPS/national nodes lacking an explicit parent link
        if "US" in scope and len(scope - {"US"}) > 0:
            aggs.add("US")
        return aggs

    def default_location(self) -> str:
        """Select the natural opening location for this hub ('US', highest-pop root jurisdiction, or first node)."""
        if "US" in self.nodes:
            return "US"
        roots = [n for n in self.nodes.values() if not n.parent_id or n.parent_id not in self.nodes]
        candidates = roots or list(self.nodes.values())
        if candidates:
            best = max(candidates, key=lambda n: (n.population if n.population is not None else -1, n.id))
            return best.id
        return "US"

    def resolve_pool(
        self,
        pool_spec: Optional[str] = "all",
        active_ids: Optional[Iterable[str]] = None,
    ) -> Optional[List[str]]:
        """
        Resolve a UI/API location selector ('all', 'states', 'US', 'aggregates', 'level:<l>', 'region:<r>',
        single location ID, or comma-separated IDs) into explicit non-overlapping location IDs.
        Returns None when `pool_spec` does not restrict locations at all (empty graph fallback).
        """
        scope_set = set(active_ids) if active_ids is not None else set(self.nodes.keys())
        if not scope_set:
            return None

        spec = (pool_spec or "all").strip()
        low = spec.lower()
        aggs = self.aggregate_locations_in_scope(scope_set)
        leaves = sorted(scope_set - aggs) or sorted(scope_set)

        if low in ("all", "primary", "leaves", ""):
            return leaves
        if low == "aggregates":
            return sorted(aggs) if aggs else []
        if low == "states":
            # Backwards-compatible: US FIPS states if present, else any level=='state', else primary leaves
            fips_states = [k for k in scope_set if k != "US" and (k in US_STATES_REF or self.nodes.get(k, GeoNode(k, k, k, k)).level in ("state", "territory"))]
            if fips_states:
                return sorted(fips_states)
            state_lvl = [k for k in scope_set if self.nodes.get(k) and self.nodes[k].level == "state"]
            return sorted(state_lvl) if state_lvl else leaves
        if low.startswith("level:"):
            lvl = spec[6:].strip().lower()
            return sorted(k for k in scope_set if self.nodes.get(k) and self.nodes[k].level.lower() == lvl)
        if low.startswith("region:"):
            reg = spec[7:].strip().lower()
            matched = [
                k for k in scope_set
                if self.nodes.get(k) and (self.nodes[k].region or "").lower() == reg
            ]
            # Avoid double-counting within the region if a state aggregate is also present
            reg_aggs = self.aggregate_locations_in_scope(matched)
            return sorted(set(matched) - reg_aggs) if (set(matched) - reg_aggs) else sorted(matched)
        if "," in spec:
            parts = [self.normalize_location_id(p) for p in spec.split(",") if p.strip()]
            return [p for p in parts if p in scope_set] or parts

        norm = self.normalize_location_id(spec)
        return [norm]

    def pooling_cohorts(self) -> List[Dict[str, Any]]:
        """Enumerate meaningful pooling cohorts present in this hub for the manifest/UI."""
        aggs = self.aggregate_locations_in_scope()
        leaves = set(self.nodes.keys()) - aggs
        cohorts: List[Dict[str, Any]] = [
            {"id": "all", "label": "Primary locations", "count": len(leaves)},
        ]
        if aggs:
            cohorts.append({"id": "aggregates", "label": "Aggregate totals", "count": len(aggs)})
        levels = sorted({n.level for n in self.nodes.values() if n.level})
        for lvl in levels:
            cnt = sum(1 for n in self.nodes.values() if n.level == lvl)
            if cnt > 1:
                cohorts.append({"id": f"level:{lvl}", "label": f"Level: {lvl}", "count": cnt})
        return cohorts

    def geo_summary(self) -> Dict[str, Any]:
        aggs = self.aggregate_locations_in_scope()
        levels = sorted({n.level for n in self.nodes.values() if n.level})
        regions = sorted({n.region for n in self.nodes.values() if n.region})
        return {
            "default_location": self.default_location(),
            "uses_us_fips": self.uses_us_fips,
            "aggregate_locations": sorted(aggs),
            "levels": levels,
            "regions": regions,
            "pooling_cohorts": self.pooling_cohorts(),
        }

    def to_legacy_locations_map(self) -> Dict[str, Dict[str, Any]]:
        aggs = self.aggregate_locations_in_scope()
        return {loc_id: node.to_legacy_dict(is_aggregate=(loc_id in aggs)) for loc_id, node in self.nodes.items()}


def _tasks_locations(tasks_config: Optional[Dict[str, Any]]) -> List[str]:
    if not isinstance(tasks_config, dict):
        return []
    seen: List[str] = []
    seen_set: Set[str] = set()
    for rnd in tasks_config.get("rounds") or []:
        if not isinstance(rnd, dict):
            continue
        for mt in rnd.get("model_tasks") or []:
            if not isinstance(mt, dict):
                continue
            spec = (mt.get("task_ids") or {}).get("location") or {}
            if not isinstance(spec, dict):
                continue
            for k in ("required", "optional"):
                vals = spec.get(k)
                if isinstance(vals, list):
                    for v in vals:
                        s = str(v).strip()
                        if s and s not in seen_set:
                            seen_set.add(s)
                            seen.append(s)
                elif isinstance(vals, str) and vals.strip():
                    s = vals.strip()
                    if s not in seen_set:
                        seen_set.add(s)
                        seen.append(s)
    return seen


def build_geo_graph(
    locations_csv: Optional[Path] = None,
    *,
    tasks_config: Optional[Dict[str, Any]] = None,
    observed_locations: Optional[Iterable[str]] = None,
    fallback_us: bool = True,
) -> GeoGraph:
    """
    Construct a GeoGraph from a hub's `locations.csv` (FluSight or MetroCast format), `tasks.json`,
    observed data locations, and built-in US/EU reference tables.
    """
    nodes: Dict[str, GeoNode] = {}
    csv_raw_ids: Set[str] = set()

    # 1. Read auxiliary-data/locations.csv if present
    rows: List[Dict[str, Any]] = []
    if locations_csv is not None and Path(locations_csv).is_file():
        try:
            df = pl.read_csv(
                locations_csv,
                schema_overrides={"location": pl.String, "original_location_code": pl.String},
                null_values=NULL_VALUES,
                ignore_errors=False,
            )
            if "population" in df.columns:
                df = df.with_columns(pl.col("population").cast(pl.Float64, strict=False))
            rows = df.to_dicts()
        except Exception as exc:
            logger.warning("Error reading %s: %s", locations_csv, exc)

    # First pass: inspect whether CSV rows look like US FIPS vs MetroCast vs custom
    raw_ids = [str(r.get("location") or "").strip() for r in rows if r.get("location") is not None]
    task_locs = _tasks_locations(tasks_config)
    obs_locs = [str(x).strip() for x in (observed_locations or []) if x is not None and str(x).strip()]
    all_raw_ids = raw_ids + task_locs + obs_locs

    fips_hits = sum(1 for lid in all_raw_ids if (lid.zfill(2) if len(lid) == 1 and lid.isdigit() else lid) in US_STATES_REF)
    has_metrocast_cols = any("original_location_code" in r or "state_abb" in r or "location_type" in r for r in rows)
    uses_us_fips = (not has_metrocast_cols) and fips_hits >= max(1, min(3, len(all_raw_ids)))

    # Track statewide aggregate rows (MetroCast original_location_code == 'All') keyed by state_abb
    state_agg_by_abb: Dict[str, str] = {}
    pending_rows: List[Tuple[str, Dict[str, Any]]] = []

    for r in rows:
        raw_id = str(r.get("location") or "").strip()
        if not raw_id:
            continue
        loc_id = raw_id.zfill(2) if (uses_us_fips and len(raw_id) == 1 and raw_id.isdigit()) else raw_id
        csv_raw_ids.add(loc_id)

        pop_raw = r.get("population")
        pop = int(round(float(pop_raw))) if pop_raw is not None and str(pop_raw) != "nan" else None
        orig_code = str(r.get("original_location_code") or "").strip()
        state_name = str(r.get("state") or "").strip() or None
        state_abb = str(r.get("state_abb") or "").strip().upper() or None
        loc_type = str(r.get("location_type") or "").strip().lower()
        loc_name = str(r.get("location_name") or "").strip() or loc_id
        counties_raw = str(r.get("hsa_counties") or "").strip()
        counties = [c.strip() for c in counties_raw.split(",") if c.strip()] if counties_raw else None

        # Check statewide aggregate first (MetroCast uses original_location_code == "All")
        if orig_code.lower() == "all":
            if state_abb:
                state_agg_by_abb[state_abb] = loc_id
            canon = _canonical_us_state(state_abb, state_name) or f"US:state:{loc_id}"
            state_fips = US_ABBR_TO_FIPS.get(state_abb or "")
            ref = US_STATES_REF.get(state_fips or "", {})
            nodes[loc_id] = GeoNode(
                id=loc_id,
                canonical_id=canon,
                abbr=state_abb or str(r.get("abbreviation") or loc_id)[:10],
                name=loc_name,
                level="state",
                parent_id=None,
                region=ref.get("region") or state_abb,
                population=pop or ref.get("population"),
                lat=ref.get("lat"),
                lon=ref.get("lon"),
                counties=counties,
                is_hub_aggregate=True,
            )
            continue

        if loc_id in US_STATES_REF:
            ref = US_STATES_REF[loc_id]
            abbr = str(r.get("abbreviation") or ref["abbr"]).strip()
            nodes[loc_id] = GeoNode(
                id=loc_id,
                canonical_id="US" if loc_id == "US" else f"US:{loc_id}",
                abbr=abbr,
                name=loc_name if loc_name != loc_id else ref["name"],
                level=ref["level"],
                parent_id="US" if loc_id != "US" else None,
                region=ref.get("region"),
                population=pop if pop is not None else ref.get("population"),
                lat=ref.get("lat"),
                lon=ref.get("lon"),
                counties=counties,
                is_hub_aggregate=(loc_id == "US"),
            )
            continue

        pending_rows.append((loc_id, {
            "r": r, "pop": pop, "state_name": state_name, "state_abb": state_abb,
            "loc_type": loc_type, "loc_name": loc_name, "counties": counties,
        }))

    for loc_id, meta in pending_rows:
        r = meta["r"]
        state_abb = meta["state_abb"]
        state_name = meta["state_name"]
        loc_type = meta["loc_type"]
        loc_name = meta["loc_name"]
        parent_id = state_agg_by_abb.get(state_abb or "")
        st_canon = _canonical_us_state(state_abb, state_name) or "US"
        if "ca_region" in loc_type or "nc_flu_region" in loc_type or "ut_region" in loc_type:
            level = "region"
        elif "hsa" in loc_type:
            level = "hsa"
        elif loc_id in EUROPE_REF:
            level = EUROPE_REF[loc_id]["level"]
        else:
            level = "subnational" if parent_id else "custom"
        explicit_abbr = r.get("abbreviation")
        abbr = str(explicit_abbr).strip() if explicit_abbr else _short_substate_abbr(loc_id, loc_name, state_abb)
        ref = EUROPE_REF.get(loc_id) or _LEGACY_US_SUBNATIONAL_REF.get(loc_id) or {}
        nodes[loc_id] = GeoNode(
            id=loc_id,
            canonical_id=ref.get("canonical_id") or (f"EU:{loc_id}" if loc_id in EUROPE_REF else f"{st_canon}:{loc_id}"),
            abbr=ref.get("abbr") if not explicit_abbr and loc_id in EUROPE_REF else abbr,
            name=loc_name,
            level=level,
            parent_id=parent_id or (ref.get("parent_id") if ref.get("parent_id") in all_raw_ids else None),
            region=ref.get("region") or state_abb,
            population=meta["pop"] if meta["pop"] is not None else ref.get("population"),
            lat=ref.get("lat"),
            lon=ref.get("lon"),
            counties=meta["counties"],
            is_hub_aggregate=bool(ref.get("is_hub_aggregate", False)),
        )

    # 2. Supplement any locations declared in tasks.json or observed in data (crucial for RespiCast & MetroCast legacy rounds)
    extra_ids = []
    for raw in task_locs + obs_locs:
        lid = raw.zfill(2) if (uses_us_fips and len(raw) == 1 and raw.isdigit()) else raw
        if lid and lid not in nodes:
            extra_ids.append(lid)

    extra_set = set(extra_ids) | set(nodes.keys())
    for lid in extra_ids:
        if lid in US_STATES_REF:
            ref = US_STATES_REF[lid]
            nodes[lid] = GeoNode(
                id=lid,
                canonical_id="US" if lid == "US" else f"US:{lid}",
                abbr=ref["abbr"],
                name=ref["name"],
                level=ref["level"],
                parent_id="US" if (lid != "US" and "US" in extra_set) else None,
                region=ref.get("region"),
                population=ref.get("population"),
                lat=ref.get("lat"),
                lon=ref.get("lon"),
                is_hub_aggregate=(lid == "US"),
            )
        elif lid in EUROPE_REF:
            ref = EUROPE_REF[lid]
            p_hint = ref.get("parent_id")
            nodes[lid] = GeoNode(
                id=lid,
                canonical_id=f"EU:{lid}",
                abbr=ref["abbr"],
                name=ref["name"],
                level=ref["level"],
                parent_id=p_hint if p_hint in extra_set else None,
                region=ref.get("region"),
                population=ref.get("population"),
                lat=ref.get("lat"),
                lon=ref.get("lon"),
            )
        elif lid in _LEGACY_US_SUBNATIONAL_REF:
            ref = _LEGACY_US_SUBNATIONAL_REF[lid]
            st_abb = ref.get("state_abb")
            p_hint = ref.get("parent_hint")
            parent_id = p_hint if (p_hint and p_hint in extra_set) else state_agg_by_abb.get(st_abb or "")
            st_canon = _canonical_us_state(st_abb, None) or "US"
            nodes[lid] = GeoNode(
                id=lid,
                canonical_id=f"{st_canon}:{lid}",
                abbr=ref["abbr"],
                name=ref["name"],
                level=ref["level"],
                parent_id=parent_id,
                region=ref.get("region"),
                lat=ref.get("lat"),
                lon=ref.get("lon"),
                is_hub_aggregate=bool(ref.get("is_hub_aggregate", False)),
            )
        else:
            # Unknown custom node (e.g. local municipal hub)
            clean_name = lid.replace("-", " ").replace("_", " ").title()
            nodes[lid] = GeoNode(
                id=lid,
                canonical_id=f"CUSTOM:{lid}",
                abbr=lid[:12],
                name=clean_name,
                level="custom",
            )

    # Link FIPS states under US if US is present and any state lacked parent_id
    if "US" in nodes:
        for lid, node in nodes.items():
            if lid != "US" and node.parent_id is None and lid in US_STATES_REF:
                node.parent_id = "US"

    # If the graph is completely empty (bare test stub with no locations.csv and no tasks.json), fallback to US
    if not nodes and fallback_us:
        ref = US_STATES_REF["US"]
        nodes["US"] = GeoNode(
            id="US",
            canonical_id="US",
            abbr="US",
            name=ref["name"],
            level="country",
            region="National",
            population=ref["population"],
            lat=ref["lat"],
            lon=ref["lon"],
            is_hub_aggregate=True,
        )
        uses_us_fips = True

    return GeoGraph(nodes, uses_us_fips=uses_us_fips)
