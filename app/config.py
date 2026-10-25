"""Runtime configuration, read from environment variables (or a .env file)."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BASE_DIR / ".env")

DEFAULT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    groq_api_key: str
    groq_model: str
    groq_base_url: str
    storage_backend: str  # "supabase" or "sqlite"
    database_path: str  # used by the sqlite backend
    supabase_url: str
    supabase_service_key: str
    supabase_bucket: str
    max_upload_mb: int
    session_days: int
    cookie_secure: bool

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


def get_settings() -> Settings:
    supabase_url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    backend = os.getenv("STORAGE_BACKEND", "").strip().lower() or ("supabase" if supabase_url else "sqlite")
    if backend not in {"supabase", "sqlite"}:
        raise ValueError("STORAGE_BACKEND must be 'supabase' or 'sqlite'")

    return Settings(
        groq_api_key=os.getenv("GROQ_API_KEY", "").strip(),
        groq_model=os.getenv("GROQ_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        groq_base_url=os.getenv("GROQ_BASE_URL", DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL,
        storage_backend=backend,
        database_path=os.getenv("DATABASE_PATH", str(BASE_DIR / "data" / "nutrilens.db")),
        supabase_url=supabase_url,
        supabase_service_key=os.getenv("SUPABASE_SERVICE_KEY", "").strip(),
        supabase_bucket=os.getenv("SUPABASE_BUCKET", "meal-thumbnails").strip() or "meal-thumbnails",
        max_upload_mb=int(os.getenv("MAX_UPLOAD_MB", "10")),
        session_days=int(os.getenv("SESSION_DAYS", "14")),
        cookie_secure=_env_bool("COOKIE_SECURE", default=False),
    )
