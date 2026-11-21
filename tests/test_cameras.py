from app.live import cameras


def test_tfl_keeps_available_cameras_with_images():
    places = [
        {"id": "JamCams_1", "commonName": "A406 Billet Upass", "lat": 51.6, "lon": -0.01, "additionalProperties": [
            {"key": "available", "value": "true"},
            {"key": "imageUrl", "value": "https://s3.example/1.jpg"},
            {"key": "videoUrl", "value": "https://s3.example/1.mp4"},
            {"key": "view", "value": "West"},
        ]},
        {"id": "JamCams_2", "commonName": "Offline cam", "lat": 51.5, "lon": -0.1, "additionalProperties": [
            {"key": "available", "value": "false"},
            {"key": "imageUrl", "value": "https://s3.example/2.jpg"},
        ]},
    ]
    assert cameras.parse_tfl(places) == [
        ["JamCams_1", "TfL", "A406 Billet Upass (West)", 51.6, -0.01, "https://s3.example/1.jpg", "https://s3.example/1.mp4", "mp4"],
    ]


def test_caltrans_marks_hls_streams_and_skips_out_of_service():
    def record(index, in_service="true", stream="https://wzmedia.example/CCTV-1.stream/playlist.m3u8", lat="34.08"):
        return {"cctv": {
            "index": index,
            "inService": in_service,
            "location": {"district": "7", "locationName": "I-110 : Avenue 26", "nearbyPlace": "Cypress Park",
                         "latitude": lat, "longitude": "-118.22"},
            "imageData": {"streamingVideoURL": stream, "static": {"currentImageURL": "https://cwwp2.example/x.jpg"}},
        }}

    rows = cameras.parse_caltrans([
        record("1"),
        record("2", stream="Not Reported"),
        record("3", in_service="false"),
        record("4", lat="not-a-number"),
    ])
    assert [r[0] for r in rows] == ["caltrans:7:1", "caltrans:7:2"]
    assert rows[0][2] == "I-110 : Avenue 26 - Cypress Park"
    assert rows[0][6:] == ["https://wzmedia.example/CCTV-1.stream/playlist.m3u8", "hls"]
    assert rows[1][6:] == [None, None]


def test_drivebc_skips_off_and_stale_and_flips_geojson_order():
    cams = cameras.parse_drivebc([
        {"id": 583, "caption": "Hwy 31A at Retallack", "is_on": True, "marked_stale": False,
         "location": {"type": "Point", "coordinates": [-117.2, 50.0]}, "links": {"imageDisplay": "/images/583.jpg"}},
        {"id": 2, "is_on": False, "location": {"coordinates": [0, 0]}, "links": {"imageDisplay": "/x"}},
        {"id": 3, "is_on": True, "marked_stale": True, "location": {"coordinates": [0, 0]}, "links": {"imageDisplay": "/x"}},
    ])
    assert cams == [["drivebc:583", "DriveBC", "Hwy 31A at Retallack", 50.0, -117.2,
                     "https://www.drivebc.ca/images/583.jpg", None, None]]


def test_finland_uses_first_collected_preset_image():
    [cam] = cameras.parse_finland({"features": [
        {"geometry": {"coordinates": [23.99, 60.05, 0.0]}, "properties": {
            "id": "C01503", "name": "kt51_Inkoo", "collectionStatus": "GATHERING",
            "presets": [{"id": "C0150300", "inCollection": False}, {"id": "C0150301", "inCollection": True}]}},
        {"geometry": {"coordinates": [0, 0, 0]}, "properties": {"id": "X", "collectionStatus": "REMOVED_TEMPORARILY",
                                                                 "presets": [{"id": "X1", "inCollection": True}]}},
    ]})
    assert cam[2] == "kt51 Inkoo"
    assert cam[3:5] == [60.05, 23.99]
    assert cam[5] == "https://weathercam.digitraffic.fi/C0150301.jpg"


def test_nzta_drops_offline_and_makes_absolute_urls():
    cams = cameras.parse_nzta({"response": {"camera": [
        {"id": 714, "name": "SH1 Tinwald ", "description": "South along Hinds Highway", "latitude": -43.9,
         "longitude": 171.7, "imageUrl": "/camera/714.jpg", "offline": False, "underMaintenance": False},
        {"id": 2, "name": "Down", "latitude": 0, "longitude": 0, "imageUrl": "/camera/2.jpg", "offline": True},
    ]}})
    assert [c[0] for c in cams] == ["nz:714"]
    assert cams[0][2] == "SH1 Tinwald - South along Hinds Highway"
    assert cams[0][5] == "https://trafficnz.info/camera/714.jpg"


def test_hongkong_xml():
    xml = """<image-list><image><key>H429F</key><description>Aberdeen Praya Road [H429F]</description>
             <latitude>22.24845</latitude><longitude>114.1505</longitude>
             <url>https://tdcctv.data.one.gov.hk/H429F.JPG</url></image></image-list>"""
    assert cameras.parse_hongkong(xml) == [["hk:H429F", "HK Transport Dept", "Aberdeen Praya Road [H429F]",
                                            22.24845, 114.1505, "https://tdcctv.data.one.gov.hk/H429F.JPG", None, None]]


def test_windy_parsing_keeps_attribution_links_and_skips_inactive():
    payload = {"total": 2, "webcams": [
        {
            "webcamId": 1179853135, "title": "Sydney Harbour", "status": "active", "lastUpdatedOn": "2026-11-21T10:00:00.000Z",
            "location": {"latitude": -33.85, "longitude": 151.21, "city": "Sydney", "country": "Australia"},
            "images": {"current": {"preview": "https://images.example/p.jpg?token=abc", "thumbnail": "https://images.example/t.jpg?token=abc"}},
            "player": {"live": "https://webcams.windy.com/webcams/public/embed/player/1179853135/live"},
            "urls": {"detail": "https://www.windy.com/webcams/1179853135"},
        },
        {"webcamId": 2, "title": "Dead cam", "status": "inactive", "location": {"latitude": 0, "longitude": 0}},
    ]}
    [cam] = cameras.parse_windy(payload)
    assert cam["id"] == "windy:1179853135"
    assert cam["place"] == "Sydney, Australia"
    assert cam["image"] == "https://images.example/p.jpg?token=abc"  # untouched, per Windy's terms
    assert cam["detail_url"] == "https://www.windy.com/webcams/1179853135"
    assert cam["player"].endswith("/live")
