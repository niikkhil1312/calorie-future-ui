"""SQLite persistence for analysed meals."""

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    thumbnail BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meals_date ON meals (meal_date);
"""


class Database:
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
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def insert_meal(
        self,
        *,
        meal_name: str,
        portion: str,
        meal_date: str,
        model: str,
        analysis: dict[str, Any],
        thumbnail: bytes,
    ) -> int:
        totals = analysis["totals"]
        created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO meals (created_at, meal_date, meal_name, portion, model,
                                   calories, protein, carbs, fat, analysis, thumbnail)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    created_at,
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
            return int(cursor.lastrowid)

    def list_meals(self, meal_date: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM meals WHERE meal_date = ? ORDER BY created_at DESC, id DESC",
                (meal_date,),
            ).fetchall()
        return [_meal_from_row(row) for row in rows]

    def get_meal(self, meal_id: int) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM meals WHERE id = ?", (meal_id,)).fetchone()
        return _meal_from_row(row) if row else None

    def get_thumbnail(self, meal_id: int) -> bytes | None:
        with self._connect() as conn:
            row = conn.execute("SELECT thumbnail FROM meals WHERE id = ?", (meal_id,)).fetchone()
        return bytes(row["thumbnail"]) if row else None

    def delete_meal(self, meal_id: int) -> bool:
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM meals WHERE id = ?", (meal_id,))
            return cursor.rowcount > 0

    def daily_totals(self, start: str, end: str) -> dict[str, dict[str, Any]]:
        """Totals per meal_date between start and end (inclusive, ISO dates)."""
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
                WHERE meal_date BETWEEN ? AND ?
                GROUP BY meal_date
                """,
                (start, end),
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
        "thumbnail_url": f"/api/meals/{row['id']}/thumbnail",
    }
