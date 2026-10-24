"""Runtime configuration, read from environment variables (or a .env file)."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BASE_DIR / ".env")

DEFAULT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"


@dataclass(frozen=True)
class Settings:
    groq_api_key: str
    groq_model: str
    groq_base_url: str
    database_path: str
    max_upload_mb: int

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


def get_settings() -> Settings:
    return Settings(
        groq_api_key=os.getenv("GROQ_API_KEY", "").strip(),
        groq_model=os.getenv("GROQ_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        groq_base_url=os.getenv("GROQ_BASE_URL", DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL,
        database_path=os.getenv("DATABASE_PATH", str(BASE_DIR / "data" / "nutrilens.db")),
        max_upload_mb=int(os.getenv("MAX_UPLOAD_MB", "10")),
    )
