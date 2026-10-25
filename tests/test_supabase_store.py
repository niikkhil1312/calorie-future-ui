import json

import httpx
import pytest

from app.store_errors import DuplicateEmail, StorageError
from app.supabase_store import SupabaseStore

URL = "https://project.supabase.co"
NEW_KEY = "sb_secret_test_key"
LEGACY_JWT = "eyJhbGciOiJIUzI1NiJ9.service.role"
ANALYSIS = {
    "foods": [{"name": "Idli", "emoji": "🍚", "portion": "2", "calories": 130, "protein": 4, "carbs": 26, "fat": 1}],
    "totals": {"calories": 130, "protein": 4.0, "carbs": 26.0, "fat": 1.0},
    "micronutrients": [],
    "notes": "",
}


class Recorder:
    """Records every request and returns canned responses keyed by (method, path prefix)."""

    def __init__(self, responses=None):
        self.requests: list[httpx.Request] = []
        self.responses = responses or {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        for (method, prefix), response in self.responses.items():
            if request.method == method and request.url.path.startswith(prefix):
                return response
        return httpx.Response(200, json=[])

    def last(self, method: str, prefix: str) -> httpx.Request:
        matches = [r for r in self.requests if r.method == method and r.url.path.startswith(prefix)]
        assert matches, f"no {method} request to {prefix}"
        return matches[-1]


def make_store(recorder: Recorder, key: str = NEW_KEY) -> SupabaseStore:
    return SupabaseStore(URL, key, "meal-thumbnails", transport=httpx.MockTransport(recorder))


def test_requires_url_and_key():
    with pytest.raises(StorageError):
        SupabaseStore("", NEW_KEY, "b")
    with pytest.raises(StorageError):
        SupabaseStore(URL, "", "b")


def test_new_secret_keys_are_sent_only_in_apikey_header():
    recorder = Recorder()
    make_store(recorder).get_user_by_email("a@example.com")
    request = recorder.requests[0]
    assert request.headers["apikey"] == NEW_KEY
    assert "authorization" not in request.headers


def test_legacy_jwt_keys_are_also_sent_as_bearer():
    recorder = Recorder()
    make_store(recorder, key=LEGACY_JWT).get_user_by_email("a@example.com")
    request = recorder.requests[0]
    assert request.headers["authorization"] == f"Bearer {LEGACY_JWT}"


def test_create_user_maps_conflict_to_duplicate_email():
    recorder = Recorder({("POST", "/rest/v1/users"): httpx.Response(409, json={"code": "23505"})})
    with pytest.raises(DuplicateEmail):
        make_store(recorder).create_user("u-1", "a@example.com", "hash")


def test_get_user_by_email_filters_on_lowercase_email():
    recorder = Recorder({("GET", "/rest/v1/users"): httpx.Response(200, json=[{"id": "u-1", "email": "a@example.com", "password_hash": "h"}])})
    user = make_store(recorder).get_user_by_email("a@example.com")
    assert user["id"] == "u-1"
    assert recorder.last("GET", "/rest/v1/users").url.params["email"] == "eq.a@example.com"


def test_expired_session_returns_none():
    rows = [{"expires_at": "2000-01-01T00:00:00+00:00", "users": {"id": "u-1", "email": "a@example.com"}}]
    recorder = Recorder({("GET", "/rest/v1/sessions"): httpx.Response(200, json=rows)})
    assert make_store(recorder).get_session_user("hash") is None


def test_valid_session_returns_user():
    rows = [{"expires_at": "2999-01-01T00:00:00+00:00", "users": {"id": "u-1", "email": "a@example.com"}}]
    recorder = Recorder({("GET", "/rest/v1/sessions"): httpx.Response(200, json=rows)})
    assert make_store(recorder).get_session_user("hash") == {"id": "u-1", "email": "a@example.com"}


def test_insert_meal_uploads_thumbnail_before_saving_row():
    recorder = Recorder({
        ("POST", "/storage/v1/object/"): httpx.Response(200, json={"Key": "ok"}),
        ("POST", "/rest/v1/meals"): httpx.Response(201),
    })
    make_store(recorder).insert_meal(
        meal_id="m-1", user_id="u-1", meal_name="Breakfast", portion="small", meal_date="2026-10-25",
        model="m", analysis=ANALYSIS, thumbnail=b"\xff\xd8jpeg",
    )
    paths = [r.url.path for r in recorder.requests]
    assert paths.index("/storage/v1/object/meal-thumbnails/u-1/m-1.jpg") < paths.index("/rest/v1/meals")

    upload = recorder.last("POST", "/storage/v1/object/")
    assert upload.headers["content-type"] == "image/jpeg"
    assert upload.content == b"\xff\xd8jpeg"

    row = json.loads(recorder.last("POST", "/rest/v1/meals").content)
    assert row["user_id"] == "u-1"
    assert row["calories"] == 130
    assert row["thumbnail_path"] == "u-1/m-1.jpg"


def test_insert_meal_removes_thumbnail_when_row_save_fails():
    recorder = Recorder({
        ("POST", "/storage/v1/object/"): httpx.Response(200, json={"Key": "ok"}),
        ("POST", "/rest/v1/meals"): httpx.Response(500),
    })
    with pytest.raises(StorageError):
        make_store(recorder).insert_meal(
            meal_id="m-2", user_id="u-1", meal_name="x", portion="small", meal_date="2026-10-25",
            model="m", analysis=ANALYSIS, thumbnail=b"x",
        )
    assert any(r.method == "DELETE" and r.url.path.endswith("u-1/m-2.jpg") for r in recorder.requests)


def test_every_meal_query_is_scoped_to_the_user():
    recorder = Recorder({("GET", "/rest/v1/meals"): httpx.Response(200, json=[])})
    store = make_store(recorder)
    store.list_meals("u-1", "2026-10-25")
    store.daily_totals("u-1", "2026-10-19", "2026-10-25")
    store.get_meal("u-1", "m-1")
    for request in recorder.requests:
        assert request.url.params["user_id"] == "eq.u-1"


def test_daily_totals_aggregates_rows_per_day():
    rows = [
        {"meal_date": "2026-10-25", "calories": 300, "protein": 10.0, "carbs": 40.0, "fat": 5.0},
        {"meal_date": "2026-10-25", "calories": 200, "protein": 5.0, "carbs": 20.0, "fat": 3.0},
    ]
    recorder = Recorder({("GET", "/rest/v1/meals"): httpx.Response(200, json=rows)})
    totals = make_store(recorder).daily_totals("u-1", "2026-10-19", "2026-10-25")
    assert totals["2026-10-25"] == {"meals": 2, "calories": 500, "protein": 15.0, "carbs": 60.0, "fat": 8.0}


def test_delete_meal_returns_false_for_other_users_meal():
    recorder = Recorder({("GET", "/rest/v1/meals"): httpx.Response(200, json=[])})
    assert make_store(recorder).delete_meal("u-2", "m-1") is False
    assert not any(r.method == "DELETE" for r in recorder.requests)


def test_get_thumbnail_returns_bytes_or_none():
    row = [{"id": "m-1", "user_id": "u-1", "thumbnail_path": "u-1/m-1.jpg", "meal_name": "x",
            "meal_date": "2026-10-25", "portion": "small", "model": "m", "calories": 1, "protein": 0,
            "carbs": 0, "fat": 0, "analysis": ANALYSIS, "created_at": "2026-10-25T10:00:00+00:00"}]
    recorder = Recorder({
        ("GET", "/rest/v1/meals"): httpx.Response(200, json=row),
        ("GET", "/storage/v1/object/"): httpx.Response(200, content=b"\xff\xd8img"),
    })
    assert make_store(recorder).get_thumbnail("u-1", "m-1") == b"\xff\xd8img"

    missing = Recorder({
        ("GET", "/rest/v1/meals"): httpx.Response(200, json=row),
        ("GET", "/storage/v1/object/"): httpx.Response(404, json={}),
    })
    assert make_store(missing).get_thumbnail("u-1", "m-1") is None


def test_ensure_bucket_accepts_existing_bucket():
    recorder = Recorder({("POST", "/storage/v1/bucket"): httpx.Response(400, json={"message": "Bucket already exists"})})
    make_store(recorder).ensure_bucket()


def test_errors_do_not_leak_the_service_key():
    recorder = Recorder({("GET", "/rest/v1/users"): httpx.Response(401, json={"message": "invalid"})})
    with pytest.raises(StorageError) as excinfo:
        make_store(recorder).get_user_by_email("a@example.com")
    assert NEW_KEY not in str(excinfo.value)
