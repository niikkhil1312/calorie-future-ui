"""SQLite storage backend. Used for local development and the test suite.

Production uses SupabaseStore (app/supabase_store.py). Both expose the same methods.
"""

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .store_errors import DuplicateEmail

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    meal_date TEXT NOT NULL,
    meal_name TEXT NOT NULL,
    portion TEXT NOT NULL,
    model TEXT NOT NULL,
    calories INTEGER NOT NULL,
    protein REAL NOT NULL,
    carbs REAL NOT NULL,
    fat REAL NOT NULL,
    analysis TEXT NOT NULL,
    thumbnail BLOB
);
CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals (user_id, meal_date);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class SqliteStore:
    def __init__(self, path: str):
        self.path = path
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ── Users and sessions ──

    def create_user(self, user_id: str, email: str, password_hash: str) -> dict[str, Any]:
        try:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
                    (user_id, email, password_hash, _now()),
                )
        except sqlite3.IntegrityError as exc:
            raise DuplicateEmail(email) from exc
        return {"id": user_id, "email": email}

    def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT id, email, password_hash FROM users WHERE email = ?", (email,)).fetchone()
        return dict(row) if row else None

    def create_session(self, token_hash: str, user_id: str, expires_at: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (token_hash, user_id, _now(), expires_at),
            )

    def get_session_user(self, token_hash: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT users.id, users.email, sessions.expires_at
                FROM sessions JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
        if row is None or row["expires_at"] <= _now():
            return None
        return {"id": row["id"], "email": row["email"]}

    def delete_session(self, token_hash: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))

    # ── Meals ──

    def insert_meal(
        self,
        *,
        meal_id: str,
        user_id: str,
        meal_name: str,
        portion: str,
        meal_date: str,
        model: str,
        analysis: dict[str, Any],
        thumbnail: bytes,
    ) -> None:
        totals = analysis["totals"]
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO meals (id, user_id, created_at, meal_date, meal_name, portion, model,
                                   calories, protein, carbs, fat, analysis, thumbnail)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    meal_id,
                    user_id,
                    _now(),
                    meal_date,
                    meal_name,
                    portion,
                    model,
                    totals["calories"],
                    totals["protein"],
                    totals["carbs"],
                    totals["fat"],
                    json.dumps(analysis),
                    thumbnail,
                ),
            )

    def list_meals(self, user_id: str, meal_date: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM meals WHERE user_id = ? AND meal_date = ? ORDER BY created_at DESC, id DESC",
                (user_id, meal_date),
            ).fetchall()
        return [_meal_from_row(row) for row in rows]

    def get_meal(self, user_id: str, meal_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM meals WHERE id = ? AND user_id = ?", (meal_id, user_id)
            ).fetchone()
        return _meal_from_row(row) if row else None

    def get_thumbnail(self, user_id: str, meal_id: str) -> bytes | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT thumbnail FROM meals WHERE id = ? AND user_id = ?", (meal_id, user_id)
            ).fetchone()
        return bytes(row["thumbnail"]) if row and row["thumbnail"] is not None else None

    def delete_meal(self, user_id: str, meal_id: str) -> bool:
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM meals WHERE id = ? AND user_id = ?", (meal_id, user_id))
            return cursor.rowcount > 0

    def daily_totals(self, user_id: str, start: str, end: str) -> dict[str, dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT meal_date,
                       COUNT(*) AS meals,
                       SUM(calories) AS calories,
                       SUM(protein) AS protein,
                       SUM(carbs) AS carbs,
                       SUM(fat) AS fat
                FROM meals
                WHERE user_id = ? AND meal_date BETWEEN ? AND ?
                GROUP BY meal_date
                """,
                (user_id, start, end),
            ).fetchall()
        return {
            row["meal_date"]: {
                "meals": row["meals"],
                "calories": int(row["calories"]),
                "protein": round(row["protein"], 1),
                "carbs": round(row["carbs"], 1),
                "fat": round(row["fat"], 1),
            }
            for row in rows
        }


def _meal_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "meal_date": row["meal_date"],
        "meal_name": row["meal_name"],
        "portion": row["portion"],
        "model": row["model"],
        "totals": {
            "calories": row["calories"],
            "protein": row["protein"],
            "carbs": row["carbs"],
            "fat": row["fat"],
        },
        "analysis": json.loads(row["analysis"]),
    }
