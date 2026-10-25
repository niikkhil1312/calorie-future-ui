from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.main import create_app

PASSWORD = "correct-horse-battery"

GOOD_REPLY = """```json
{
  "foods": [
    {"name": "Dal Tadka", "emoji": "🍛", "portion": "1 katori (150 ml)",
     "calories": 180, "protein": 9, "carbs": 22, "fat": 7},
    {"name": "Jeera Rice", "emoji": "🍚", "portion": "1 cup",
     "calories": "~240 kcal", "protein": 4, "carbs": 48, "fat": 4},
    {"name": "Papad", "emoji": "🫓", "portion": "1 piece",
     "calories": 60, "protein": 2, "carbs": 9, "fat": 2},
    {"name": "Cucumber Raita", "emoji": "🥒", "portion": "half katori",
     "calories": 50, "protein": 2, "carbs": 4, "fat": 2}
  ],
  "totals": {"calories": 530, "protein": 17, "carbs": 83, "fat": 15},
  "micronutrients": [{"name": "Iron", "amount": "3 mg"}, {"name": "Fiber", "amount": "6 g"}],
  "notes": "Add a vegetable side to increase fibre."
}
```"""


class FakeVision:
    """Stands in for VisionClient so tests never call Groq."""

    def __init__(self, reply: str = GOOD_REPLY, configured: bool = True, error: Exception | None = None):
        self.reply = reply
        self._configured = configured
        self.error = error
        self.model = "fake-model"
        self.calls: list[tuple[int, str, str]] = []

    @property
    def configured(self) -> bool:
        return self._configured

    def analyze(self, image_jpeg: bytes, meal_name: str = "", portion: str = "regular") -> str:
        self.calls.append((len(image_jpeg), meal_name, portion))
        if self.error:
            raise self.error
        return self.reply


def make_png(size=(64, 48), color=(200, 100, 50), mode="RGB") -> bytes:
    buffer = BytesIO()
    Image.new(mode, size, color).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        groq_api_key="test-key",
        groq_model="fake-model",
        groq_base_url="http://groq.invalid/openai/v1",
        storage_backend="sqlite",
        database_path=str(tmp_path / "test.db"),
        supabase_url="",
        supabase_service_key="",
        supabase_bucket="meal-thumbnails",
        max_upload_mb=1,
        session_days=14,
        cookie_secure=False,
    )


@pytest.fixture
def vision() -> FakeVision:
    return FakeVision()


def sign_up(client: TestClient, email: str = "cook@example.com", password: str = PASSWORD) -> dict:
    response = client.post(
        "/api/auth/signup",
        json={"email": email, "password": password},
        headers={"X-Requested-With": "TellMeCalories"},
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def client(settings, vision):
    """A client signed in as a fresh user. Requests carry the CSRF header by default."""
    with TestClient(create_app(settings=settings, vision=vision)) as test_client:
        test_client.headers["X-Requested-With"] = "TellMeCalories"
        sign_up(test_client)
        yield test_client
