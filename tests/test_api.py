from datetime import date, timedelta

from app.groq_client import VisionError
from tests.conftest import FakeVision, make_png, sign_up


def upload(client, data=None, name="meal.png", content=None, content_type="image/png"):
    form = {"meal_name": "Lunch", "portion": "regular", "meal_date": date.today().isoformat()}
    form.update(data or {})
    return client.post(
        "/api/meals/analyze",
        data=form,
        files={"file": (name, content if content is not None else make_png(), content_type)},
    )


def test_health_reports_configuration(client):
    body = client.get("/api/health").json()
    assert body == {"status": "ok", "groq_configured": True, "model": "fake-model", "storage": "sqlite"}


def test_analyze_saves_meal_and_returns_public_shape(client, vision):
    response = upload(client)

    assert response.status_code == 201
    meal = response.json()
    assert meal["meal_name"] == "Lunch"
    assert meal["portion"] == "regular"
    assert meal["meal_date"] == date.today().isoformat()
    assert len(meal["analysis"]["foods"]) == 4
    assert meal["totals"]["calories"] == 180 + 240 + 60 + 50
    assert meal["health"]["score"] >= 20
    assert set(meal["macro_split"]) == {"protein_pct", "carbs_pct", "fat_pct"}
    assert meal["thumbnail_url"] == f"/api/meals/{meal['id']}/thumbnail"
    assert vision.calls and vision.calls[0][1:] == ("Lunch", "regular")


def test_saved_meal_appears_in_log_summary_and_thumbnail(client):
    meal = upload(client).json()

    listed = client.get("/api/meals", params={"date": meal["meal_date"]}).json()
    assert [m["id"] for m in listed] == [meal["id"]]

    summary = client.get("/api/summary", params={"date": meal["meal_date"]}).json()
    assert summary["today"]["meals"] == 1
    assert summary["today"]["calories"] == meal["totals"]["calories"]

    thumb = client.get(meal["thumbnail_url"])
    assert thumb.status_code == 200
    assert thumb.headers["content-type"] == "image/jpeg"
    assert thumb.content[:2] == b"\xff\xd8"


def test_delete_removes_meal(client):
    meal = upload(client).json()

    assert client.delete(f"/api/meals/{meal['id']}").status_code == 204
    assert client.get(f"/api/meals/{meal['id']}").status_code == 404
    assert client.delete(f"/api/meals/{meal['id']}").status_code == 404


def test_summary_returns_seven_zero_filled_days(client):
    upload(client)
    today = date.today()

    summary = client.get("/api/summary").json()

    days = [entry["date"] for entry in summary["series"]]
    assert len(days) == 7
    assert days[-1] == today.isoformat()
    assert days[0] == (today - timedelta(days=6)).isoformat()
    assert summary["series"][-1]["meals"] == 1
    assert summary["series"][0]["calories"] == 0


def test_non_image_upload_is_rejected(client):
    response = upload(client, name="notes.txt", content=b"hello world", content_type="text/plain")
    assert response.status_code == 400


def test_empty_upload_is_rejected(client):
    assert upload(client, content=b"").status_code == 400


def test_oversized_upload_is_rejected(client):
    too_big = b"0" * (1024 * 1024 + 1)
    assert upload(client, content=too_big).status_code == 413


def test_invalid_portion_is_rejected(client):
    assert upload(client, data={"portion": "huge"}).status_code == 400


def test_invalid_date_is_rejected(client):
    assert upload(client, data={"meal_date": "24/10/2026"}).status_code == 400
    assert client.get("/api/meals", params={"date": "tomorrow"}).status_code == 400


def test_model_rejection_returns_422(settings):
    from fastapi.testclient import TestClient

    from app.main import create_app

    app = create_app(settings=settings, vision=FakeVision(reply='{"error": "No food here."}'))
    with TestClient(app) as client:
        client.headers["X-Requested-With"] = "NutriLens"
        sign_up(client)
        response = upload(client)
    assert response.status_code == 422
    assert response.json()["detail"] == "No food here."


def test_unparseable_model_reply_returns_502(settings):
    from fastapi.testclient import TestClient

    from app.main import create_app

    app = create_app(settings=settings, vision=FakeVision(reply="I think it's pizza!"))
    with TestClient(app) as client:
        client.headers["X-Requested-With"] = "NutriLens"
        sign_up(client)
        response = upload(client)
    assert response.status_code == 502


def test_groq_failure_returns_502(settings):
    from fastapi.testclient import TestClient

    from app.main import create_app

    app = create_app(settings=settings, vision=FakeVision(error=VisionError("Groq returned HTTP 500")))
    with TestClient(app) as client:
        client.headers["X-Requested-With"] = "NutriLens"
        sign_up(client)
        response = upload(client)
    assert response.status_code == 502
    assert "HTTP 500" in response.json()["detail"]


def test_missing_api_key_returns_503(settings):
    from fastapi.testclient import TestClient

    from app.main import create_app

    app = create_app(settings=settings, vision=FakeVision(configured=False))
    with TestClient(app) as client:
        client.headers["X-Requested-With"] = "NutriLens"
        sign_up(client)
        assert client.get("/api/health").json()["groq_configured"] is False
        response = upload(client)
    assert response.status_code == 503
    assert "GROQ_API_KEY" in response.json()["detail"]


def test_static_frontend_is_served(client):
    page = client.get("/")
    assert page.status_code == 200
    assert "NutriLens" in page.text
    assert client.get("/app.js").status_code == 200
    assert client.get("/app.css").status_code == 200
