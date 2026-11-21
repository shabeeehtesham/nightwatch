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
