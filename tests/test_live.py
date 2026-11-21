import json

from app.live import flights, incidents, news
from app.live.ships import CHOKEPOINTS, ShipTracker, chokepoint_stats, ship_category


def gdelt_row(code="195", geo_type="4", url="https://example.com/2026/airstrike-hits-city", feature="-123",
              lat="31.5", lon="34.4", place="Gaza, Gaza Strip", added="20261121080000", mentions="3"):
    row = [""] * 61
    row[incidents.C_CODE] = code
    row[incidents.C_GEO_TYPE] = geo_type
    row[incidents.C_URL] = url
    row[incidents.C_FEATURE] = feature
    row[incidents.C_LAT] = lat
    row[incidents.C_LON] = lon
    row[incidents.C_GEO_NAME] = place
    row[incidents.C_ADDED] = added
    row[incidents.C_MENTIONS] = mentions
    return row


class TestIncidentFilter:
    def test_keeps_city_level_strike_with_conflict_keyword(self):
        kept, funnel = incidents.filter_events([gdelt_row()])
        assert len(kept) == 1
        assert funnel == {"raw": 1, "strike_codes": 1, "city_level": 1, "keyword_match": 1}

    def test_drops_non_strike_codes(self):
        kept, _ = incidents.filter_events([gdelt_row(code="040")])
        assert kept == []

    def test_drops_country_level_geocodes(self):
        kept, _ = incidents.filter_events([gdelt_row(geo_type="1")])
        assert kept == []

    def test_real_false_positives_are_filtered(self):
        # URLs taken from actual noise seen in the GDELT stream
        noise = [
            "https://www.crash.net/f1/news/1110478/1/max-verstappen-warned-george-russell",
            "https://timesofmalta.com/article/elderly-woman-hit-motorcycle-paola.1137452",
            "https://www.brightonandhovenews.org/2026/11/20/students-take-to-the-street-for-youth-strike/",
            "https://example.com/software-update-moves-toward-release",
        ]
        kept, _ = incidents.filter_events([gdelt_row(url=u) for u in noise])
        assert kept == []

    def test_keyword_must_be_whole_word(self):
        assert not incidents.CONFLICT_KEYWORDS.search("/towards-a-new-software-award")
        assert incidents.CONFLICT_KEYWORDS.search("/houthis-launch-missiles-at-jeddah")


class TestIncidentCluster:
    def test_confidence_counts_distinct_outlets_not_mentions(self):
        rows = [
            gdelt_row(url="https://a.com/airstrike-1", mentions="50"),
            gdelt_row(url="https://a.com/airstrike-2", mentions="50"),
        ]
        [place] = incidents.cluster(rows)
        assert place["outlets"] == 1
        assert place["confidence"] == "low"
        assert place["mentions"] == 100

    def test_three_outlets_is_high_confidence(self):
        rows = [gdelt_row(url=f"https://www.outlet{i}.com/airstrike") for i in range(3)]
        [place] = incidents.cluster(rows)
        assert place["confidence"] == "high"
        assert {s["domain"] for s in place["sources"]} == {"outlet0.com", "outlet1.com", "outlet2.com"}

    def test_state_media_is_labelled(self):
        [place] = incidents.cluster([gdelt_row(url="https://www.presstv.ir/Detail/missile-attack")])
        assert place["sources"][0]["state_affiliated"] is True

    def test_separate_locations_stay_separate(self):
        rows = [gdelt_row(feature="1"), gdelt_row(feature="2", place="Elsewhere")]
        assert len(incidents.cluster(rows)) == 2

    def test_window_stamps_step_back_15_minutes(self):
        stamps = incidents.window_stamps("20261121084500", hours=1)
        assert stamps == ["20261121084500", "20261121083000", "20261121081500", "20261121080000"]


class TestFlights:
    def test_skips_grounded_and_unpositioned_aircraft(self):
        payload = {"states": [
            ["abc123", "UAE123  ", "UAE", 0, 0, 55.1, 25.2, 11000.0, False, 240.0, 90.0, 0, None, 11200.0],
            ["def456", "GND1    ", "UAE", 0, 0, 55.3, 25.2, 0.0, True, 0.0, 0.0, 0, None, 0.0],
            ["ghi789", "NOPOS   ", "UAE", 0, 0, None, None, 9000.0, False, 200.0, 0.0, 0, None, 9000.0],
        ]}
        rows = flights.parse_states(payload)
        assert rows == [["abc123", "UAE123", "UAE", 55.1, 25.2, 11000, 240, 90]]


class TestNews:
    def test_parses_rss2_and_rdf_dates(self):
        rss = """<rss><channel><item><title>A</title><link>https://bbc.co.uk/a</link>
                 <pubDate>Sat, 21 Nov 2026 08:00:00 GMT</pubDate></item></channel></rss>"""
        rdf = """<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"
                 xmlns:dc="http://purl.org/dc/elements/1.1/"><item><title>B</title><link>https://dw.com/b</link>
                 <dc:date>2026-11-21T08:00:00Z</dc:date></item></rdf:RDF>"""
        [a] = news.parse_feed("BBC", rss)
        [b] = news.parse_feed("DW", rdf)
        assert a["published"] == b["published"] == 1795248000.0


class TestShips:
    def test_ais_type_categories(self):
        assert ship_category(84) == "tanker"
        assert ship_category(71) == "cargo"
        assert ship_category(None) == "unknown"

    def test_chokepoint_direction_split(self):
        hormuz = next(c for c in CHOKEPOINTS if c.name == "Strait of Hormuz")
        lat, lon = 26.5, 56.5
        ships = {
            1: {"lat": lat, "lon": lon, "sog": 12, "cog": 300, "category": "tanker"},  # into the Gulf
            2: {"lat": lat, "lon": lon, "sog": 11, "cog": 120, "category": "cargo"},   # outbound
            3: {"lat": lat, "lon": lon, "sog": 0.2, "cog": 0, "category": "tanker"},  # anchored
            4: {"lat": 0, "lon": 0, "sog": 10, "cog": 0, "category": "cargo"},         # elsewhere
        }
        stats = next(s for s in chokepoint_stats(ships) if s["name"] == hormuz.name)
        assert stats["total"] == 3
        assert stats["stationary"] == 1
        assert stats["directions"] == {hormuz.label_a: 1, hormuz.label_b: 1}
        assert stats["by_category"] == {"tanker": 2, "cargo": 1}

    def test_tracker_merges_static_data_into_positions(self, tmp_path, monkeypatch):
        monkeypatch.setattr("app.live.ships.HISTORY_FILE", tmp_path / "h.jsonl")
        t = ShipTracker(api_key="test")
        t.handle(json.dumps({
            "MessageType": "PositionReport",
            "MetaData": {"MMSI": 123, "ShipName": "TEST TANKER "},
            "Message": {"PositionReport": {"Latitude": 26.5, "Longitude": 56.5, "Sog": 12, "Cog": 300, "TrueHeading": 511}},
        }))
        t.handle(json.dumps({
            "MessageType": "ShipStaticData",
            "MetaData": {"MMSI": 123},
            "Message": {"ShipStaticData": {"Type": 84, "Destination": "RAS TANURA "}},
        }))
        ship = t.ships[123]
        assert ship["name"] == "TEST TANKER"
        assert ship["heading"] is None  # 511 means "not available"
        assert ship["category"] == "tanker"
        assert ship["destination"] == "RAS TANURA"
