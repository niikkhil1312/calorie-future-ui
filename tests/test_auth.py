from fastapi.testclient import TestClient

from app.auth import (
    SESSION_COOKIE,
    hash_password,
    hash_session_token,
    verify_password,
)
from app.config import Settings
from app.db import SqliteStore
from app.main import create_app
from tests.conftest import PASSWORD, FakeVision, make_png, sign_up

CSRF = {"X-Requested-With": "NutriLens"}


def new_client(settings: Settings, store: SqliteStore | None = None) -> TestClient:
    app = create_app(settings=settings, vision=FakeVision(), store=store)
    return TestClient(app)


def upload_meal(client: TestClient) -> dict:
    response = client.post(
        "/api/meals/analyze",
        data={"meal_name": "Lunch", "portion": "regular"},
        files={"file": ("meal.png", make_png(), "image/png")},
        headers=CSRF,
    )
    assert response.status_code == 201, response.text
    return response.json()


# ── Password hashing ──

def test_password_hash_round_trip():
    stored = hash_password(PASSWORD)
    assert stored.startswith("scrypt$")
    assert verify_password(PASSWORD, stored)
    assert not verify_password("wrong-password-value", stored)


def test_password_hashes_use_unique_salts():
    assert hash_password(PASSWORD) != hash_password(PASSWORD)


def test_malformed_stored_hash_never_verifies():
    assert not verify_password(PASSWORD, "")
    assert not verify_password(PASSWORD, "scrypt$not-enough-parts")
    assert not verify_password(PASSWORD, "bcrypt$1$1$1$00$00")


def test_session_tokens_are_stored_hashed():
    assert hash_session_token("abc") != "abc"
    assert hash_session_token("abc") == hash_session_token("abc")


# ── Sign-up and sign-in ──

def test_signup_signs_the_user_in(settings):
    with new_client(settings) as client:
        user = sign_up(client, email="  Maya@Example.COM ")
        assert user["email"] == "maya@example.com"
        me = client.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["email"] == "maya@example.com"


def test_session_cookie_is_http_only_and_lax(settings):
    with new_client(settings) as client:
        response = client.post("/api/auth/signup", json={"email": "a@example.com", "password": PASSWORD}, headers=CSRF)
        cookie_header = response.headers["set-cookie"].lower()
        assert f"{SESSION_COOKIE}=" in cookie_header
        assert "httponly" in cookie_header
        assert "samesite=lax" in cookie_header


def test_duplicate_email_is_rejected(settings):
    with new_client(settings) as client:
        sign_up(client, email="dup@example.com")
        response = client.post("/api/auth/signup", json={"email": "DUP@example.com", "password": PASSWORD}, headers=CSRF)
        assert response.status_code == 409


def test_invalid_email_and_short_password_are_rejected(settings):
    with new_client(settings) as client:
        bad_email = client.post("/api/auth/signup", json={"email": "not-an-email", "password": PASSWORD}, headers=CSRF)
        short = client.post("/api/auth/signup", json={"email": "ok@example.com", "password": "short"}, headers=CSRF)
        assert bad_email.status_code == 400
        assert short.status_code == 400


def test_login_with_correct_password_sets_a_session(settings):
    with new_client(settings) as client:
        sign_up(client, email="login@example.com")
        client.post("/api/auth/logout", headers=CSRF)
        response = client.post(
            "/api/auth/login", json={"email": "login@example.com", "password": PASSWORD}, headers=CSRF
        )
        assert response.status_code == 200
        assert client.get("/api/auth/me").status_code == 200


def test_wrong_password_and_unknown_email_look_identical(settings):
    with new_client(settings) as client:
        sign_up(client, email="known@example.com")
        client.post("/api/auth/logout", headers=CSRF)
        wrong = client.post(
            "/api/auth/login", json={"email": "known@example.com", "password": "wrong-password-value"}, headers=CSRF
        )
        unknown = client.post(
            "/api/auth/login", json={"email": "nobody@example.com", "password": "wrong-password-value"}, headers=CSRF
        )
        assert wrong.status_code == unknown.status_code == 401
        assert wrong.json() == unknown.json()


def test_logout_ends_the_session(settings):
    with new_client(settings) as client:
        sign_up(client)
        assert client.post("/api/auth/logout", headers=CSRF).status_code == 204
        client.cookies.clear()
        assert client.get("/api/auth/me").status_code == 401


def test_logout_invalidates_the_token_server_side(settings):
    with new_client(settings) as client:
        sign_up(client)
        token = client.cookies[SESSION_COOKIE]
        client.post("/api/auth/logout", headers=CSRF)
        client.cookies.set(SESSION_COOKIE, token)
        assert client.get("/api/auth/me").status_code == 401


def test_meal_routes_require_sign_in(settings):
    with new_client(settings) as client:
        assert client.get("/api/meals").status_code == 401
        assert client.get("/api/summary").status_code == 401
        assert client.get("/api/meals/some-id/thumbnail").status_code == 401
        assert client.delete("/api/meals/some-id", headers=CSRF).status_code == 401


def test_stored_session_token_is_hashed(settings):
    store = SqliteStore(settings.database_path)
    with new_client(settings, store) as client:
        sign_up(client)
        token = client.cookies[SESSION_COOKIE]
        with store._connect() as conn:
            stored = [row["token_hash"] for row in conn.execute("SELECT token_hash FROM sessions")]
        assert token not in stored
        assert hash_session_token(token) in stored


def test_expired_session_is_rejected(settings):
    store = SqliteStore(settings.database_path)
    user = store.create_user("u-1", "old@example.com", hash_password(PASSWORD))
    store.create_session(hash_session_token("stale-token"), user["id"], "2000-01-01T00:00:00+00:00")
    assert store.get_session_user(hash_session_token("stale-token")) is None


# ── Brute-force protection ──

def test_login_is_rate_limited_per_email(settings):
    with new_client(settings) as client:
        sign_up(client, email="target@example.com")
        client.post("/api/auth/logout", headers=CSRF)
        statuses = [
            client.post(
                "/api/auth/login", json={"email": "target@example.com", "password": "wrong-password-value"}, headers=CSRF
            ).status_code
            for _ in range(6)
        ]
        assert statuses[:5] == [401] * 5
        assert statuses[5] == 429


# ── CSRF header ──

def test_api_writes_without_the_custom_header_are_refused(settings):
    with new_client(settings) as client:
        response = client.post(
            "/api/auth/signup",
            json={"email": "csrf@example.com", "password": PASSWORD},
            headers={"X-Requested-With": ""},
        )
        assert response.status_code == 403
        assert client.post("/api/auth/logout", headers={"X-Requested-With": ""}).status_code == 403


# ── Tenant isolation ──

def test_users_cannot_see_or_touch_each_others_meals(settings):
    store = SqliteStore(settings.database_path)
    with new_client(settings, store) as alice:
        sign_up(alice, email="alice@example.com")
        meal = upload_meal(alice)
        alice_cookie = alice.cookies[SESSION_COOKIE]

    with new_client(settings, store) as bob:
        sign_up(bob, email="bob@example.com")
        assert bob.get("/api/meals", params={"date": meal["meal_date"]}).json() == []
        assert bob.get(f"/api/meals/{meal['id']}").status_code == 404
        assert bob.get(f"/api/meals/{meal['id']}/thumbnail").status_code == 404
        assert bob.delete(f"/api/meals/{meal['id']}", headers=CSRF).status_code == 404
        summary = bob.get("/api/summary", params={"date": meal["meal_date"]}).json()
        assert summary["today"]["meals"] == 0

    with new_client(settings, store) as alice_again:
        alice_again.cookies.set(SESSION_COOKIE, alice_cookie)
        assert alice_again.get(f"/api/meals/{meal['id']}").status_code == 200
