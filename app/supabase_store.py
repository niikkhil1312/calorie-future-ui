"""Supabase storage backend: Postgres tables via PostgREST, thumbnails via Supabase Storage.

Uses the service key, so every query is scoped by user_id in this module. Row Level Security is
enabled on all tables with no policies, which blocks the public anon key entirely.
"""

from datetime import datetime, timezone
from typing import Any

import httpx

from .store_errors import DuplicateEmail, StorageError

REQUEST_TIMEOUT = 20.0


class SupabaseStore:
    def __init__(
        self,
        url: str,
        service_key: str,
        bucket: str,
        transport: httpx.BaseTransport | None = None,
    ):
        if not url or not service_key:
            raise StorageError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        self.bucket = bucket
        headers = {"apikey": service_key}
        # Legacy service_role keys are JWTs and also go in the Authorization header.
        # New sb_secret keys are sent only in apikey.
        if not service_key.startswith("sb_"):
            headers["Authorization"] = f"Bearer {service_key}"
        self._client = httpx.Client(
            base_url=url.rstrip("/") + "/",
            headers=headers,
            timeout=REQUEST_TIMEOUT,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    # ── Setup ──

    def ensure_bucket(self) -> None:
        response = self._client.post(
            "storage/v1/bucket", json={"id": self.bucket, "name": self.bucket, "public": False}
        )
        if response.status_code in (200, 201):
            return
        if response.status_code in (400, 409) and "exist" in response.text.lower():
            return
        raise StorageError(f"Could not create storage bucket (HTTP {response.status_code})")

    # ── Users and sessions ──

    def create_user(self, user_id: str, email: str, password_hash: str) -> dict[str, Any]:
        response = self._client.post(
            "rest/v1/users",
            json={"id": user_id, "email": email, "password_hash": password_hash},
            headers={"Prefer": "return=minimal"},
        )
        if response.status_code == 409:
            raise DuplicateEmail(email)
        _check(response, "create user")
        return {"id": user_id, "email": email}

    def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        rows = self._get_rows(
            "rest/v1/users",
            {"select": "id,email,password_hash", "email": f"eq.{email}", "limit": "1"},
            "load user",
        )
        return rows[0] if rows else None

    def create_session(self, token_hash: str, user_id: str, expires_at: str) -> None:
        response = self._client.post(
            "rest/v1/sessions",
            json={"token_hash": token_hash, "user_id": user_id, "expires_at": expires_at},
            headers={"Prefer": "return=minimal"},
        )
        _check(response, "create session")

    def get_session_user(self, token_hash: str) -> dict[str, Any] | None:
        rows = self._get_rows(
            "rest/v1/sessions",
            {"select": "expires_at,users(id,email)", "token_hash": f"eq.{token_hash}", "limit": "1"},
            "load session",
        )
        if not rows or rows[0].get("users") is None:
            return None
        expires_at = datetime.fromisoformat(rows[0]["expires_at"])
        if expires_at <= datetime.now(timezone.utc):
            return None
        return {"id": rows[0]["users"]["id"], "email": rows[0]["users"]["email"]}

    def delete_session(self, token_hash: str) -> None:
        response = self._client.delete(
            "rest/v1/sessions", params={"token_hash": f"eq.{token_hash}"}
        )
        _check(response, "delete session")

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
        thumbnail_path = f"{user_id}/{meal_id}.jpg"
        self._upload_thumbnail(thumbnail_path, thumbnail)
        totals = analysis["totals"]
        response = self._client.post(
            "rest/v1/meals",
            json={
                "id": meal_id,
                "user_id": user_id,
                "meal_date": meal_date,
                "meal_name": meal_name,
                "portion": portion,
                "model": model,
                "calories": totals["calories"],
                "protein": totals["protein"],
                "carbs": totals["carbs"],
                "fat": totals["fat"],
                "analysis": analysis,
                "thumbnail_path": thumbnail_path,
            },
            headers={"Prefer": "return=minimal"},
        )
        if response.is_error:
            self._remove_object(thumbnail_path)
        _check(response, "save meal")

    def list_meals(self, user_id: str, meal_date: str) -> list[dict[str, Any]]:
        rows = self._get_rows(
            "rest/v1/meals",
            {
                "select": "*",
                "user_id": f"eq.{user_id}",
                "meal_date": f"eq.{meal_date}",
                "order": "created_at.desc,id.desc",
            },
            "list meals",
        )
        return [_meal_from_row(row) for row in rows]

    def get_meal(self, user_id: str, meal_id: str) -> dict[str, Any] | None:
        row = self._get_meal_row(user_id, meal_id)
        return _meal_from_row(row) if row else None

    def get_thumbnail(self, user_id: str, meal_id: str) -> bytes | None:
        row = self._get_meal_row(user_id, meal_id)
        if row is None or not row.get("thumbnail_path"):
            return None
        response = self._client.get(f"storage/v1/object/{self.bucket}/{row['thumbnail_path']}")
        if response.status_code == 404:
            return None
        _check(response, "load thumbnail")
        return response.content

    def delete_meal(self, user_id: str, meal_id: str) -> bool:
        row = self._get_meal_row(user_id, meal_id)
        if row is None:
            return False
        response = self._client.delete(
            "rest/v1/meals",
            params={"id": f"eq.{meal_id}", "user_id": f"eq.{user_id}"},
            headers={"Prefer": "return=minimal"},
        )
        _check(response, "delete meal")
        if row.get("thumbnail_path"):
            self._remove_object(row["thumbnail_path"])
        return True

    def daily_totals(self, user_id: str, start: str, end: str) -> dict[str, dict[str, Any]]:
        rows = self._get_rows(
            "rest/v1/meals",
            [
                ("select", "meal_date,calories,protein,carbs,fat"),
                ("user_id", f"eq.{user_id}"),
                ("meal_date", f"gte.{start}"),
                ("meal_date", f"lte.{end}"),
            ],
            "load daily totals",
        )
        totals: dict[str, dict[str, Any]] = {}
        for row in rows:
            day = totals.setdefault(
                row["meal_date"], {"meals": 0, "calories": 0, "protein": 0.0, "carbs": 0.0, "fat": 0.0}
            )
            day["meals"] += 1
            day["calories"] += int(row["calories"])
            for macro in ("protein", "carbs", "fat"):
                day[macro] += float(row[macro])
        for day in totals.values():
            for macro in ("protein", "carbs", "fat"):
                day[macro] = round(day[macro], 1)
        return totals

    # ── Helpers ──

    def _get_meal_row(self, user_id: str, meal_id: str) -> dict[str, Any] | None:
        rows = self._get_rows(
            "rest/v1/meals",
            {"select": "*", "id": f"eq.{meal_id}", "user_id": f"eq.{user_id}", "limit": "1"},
            "load meal",
        )
        return rows[0] if rows else None

    def _get_rows(self, path: str, params: Any, action: str) -> list[dict[str, Any]]:
        response = self._client.get(path, params=params)
        _check(response, action)
        return response.json()

    def _upload_thumbnail(self, path: str, content: bytes) -> None:
        response = self._client.post(
            f"storage/v1/object/{self.bucket}/{path}",
            content=content,
            headers={"Content-Type": "image/jpeg", "x-upsert": "true"},
        )
        _check(response, "upload thumbnail")

    def _remove_object(self, path: str) -> None:
        # Best effort: a leftover thumbnail is harmless, so failures here are ignored.
        try:
            self._client.delete(f"storage/v1/object/{self.bucket}/{path}")
        except httpx.HTTPError:
            pass


def _check(response: httpx.Response, action: str) -> None:
    if response.is_error:
        raise StorageError(f"Could not {action} (HTTP {response.status_code})")


def _meal_from_row(row: dict[str, Any]) -> dict[str, Any]:
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
        "analysis": row["analysis"],
    }
