"""NutriLens FastAPI application: meal photo analysis, meal log and dashboard API."""

from datetime import date, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .config import Settings, get_settings
from .db import Database
from .groq_client import VisionClient, VisionError
from .images import ImageError, prepare_images
from .nutrition import (
    MealRejected,
    NutritionError,
    health_score,
    macro_split,
    normalize_analysis,
    parse_model_json,
)

STATIC_DIR = Path(__file__).resolve().parent / "static"
PORTIONS = ("small", "regular", "large")
MAX_SUMMARY_DAYS = 31
MAX_MEAL_NAME = 80


def create_app(settings: Settings | None = None, vision: Any = None) -> FastAPI:
    settings = settings or get_settings()
    db = Database(settings.database_path)
    vision = vision or VisionClient(
        api_key=settings.groq_api_key,
        model=settings.groq_model,
        base_url=settings.groq_base_url,
    )

    app = FastAPI(title="NutriLens", version="2.0.0")

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "groq_configured": vision.configured,
            "model": vision.model,
        }

    @app.post("/api/meals/analyze", status_code=201)
    async def analyze_meal(
        file: UploadFile = File(...),
        meal_name: str = Form(""),
        portion: str = Form("regular"),
        meal_date: str | None = Form(None),
    ) -> dict[str, Any]:
        if not vision.configured:
            raise HTTPException(503, "GROQ_API_KEY is not set. Add it to .env and restart the server.")

        portion = portion.lower()
        if portion not in PORTIONS:
            raise HTTPException(400, "portion must be small, regular or large")
        meal_day = _parse_day(meal_date) if meal_date else _today()
        name = " ".join(meal_name.split())[:MAX_MEAL_NAME]

        raw = await file.read(settings.max_upload_bytes + 1)
        if len(raw) > settings.max_upload_bytes:
            raise HTTPException(413, f"Image is larger than {settings.max_upload_mb} MB")
        if not raw:
            raise HTTPException(400, "The uploaded file is empty")

        try:
            analysis_jpeg, thumbnail = prepare_images(raw)
        except ImageError as exc:
            raise HTTPException(400, str(exc)) from exc

        try:
            reply = await run_in_threadpool(vision.analyze, analysis_jpeg, name, portion)
            analysis = normalize_analysis(parse_model_json(reply))
        except MealRejected as exc:
            raise HTTPException(422, str(exc)) from exc
        except (NutritionError, VisionError) as exc:
            raise HTTPException(502, str(exc)) from exc

        meal_id = db.insert_meal(
            meal_name=name or "Unnamed meal",
            portion=portion,
            meal_date=meal_day,
            model=vision.model,
            analysis=analysis,
            thumbnail=thumbnail,
        )
        return _public_meal(db.get_meal(meal_id))

    @app.get("/api/meals")
    def list_meals(day: str | None = Query(None, alias="date")) -> list[dict[str, Any]]:
        meal_day = _parse_day(day) if day else _today()
        return [_public_meal(meal) for meal in db.list_meals(meal_day)]

    @app.get("/api/meals/{meal_id}")
    def get_meal(meal_id: int) -> dict[str, Any]:
        meal = db.get_meal(meal_id)
        if meal is None:
            raise HTTPException(404, "Meal not found")
        return _public_meal(meal)

    @app.get("/api/meals/{meal_id}/thumbnail")
    def get_thumbnail(meal_id: int) -> Response:
        content = db.get_thumbnail(meal_id)
        if content is None:
            raise HTTPException(404, "Meal not found")
        return Response(content=content, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})

    @app.delete("/api/meals/{meal_id}", status_code=204)
    def delete_meal(meal_id: int) -> Response:
        if not db.delete_meal(meal_id):
            raise HTTPException(404, "Meal not found")
        return Response(status_code=204)

    @app.get("/api/summary")
    def summary(
        day: str | None = Query(None, alias="date"),
        days: int = Query(7, ge=1, le=MAX_SUMMARY_DAYS),
    ) -> dict[str, Any]:
        end_day = _parse_day(day) if day else _today()
        end = date.fromisoformat(end_day)
        start = (end - timedelta(days=days - 1)).isoformat()
        totals = db.daily_totals(start, end_day)

        series = []
        for offset in range(days - 1, -1, -1):
            current = (end - timedelta(days=offset)).isoformat()
            series.append({"date": current, **_zero_if_missing(totals.get(current))})

        return {"date": end_day, "today": _zero_if_missing(totals.get(end_day)), "series": series}

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app


def _public_meal(meal: dict[str, Any] | None) -> dict[str, Any]:
    if meal is None:
        raise HTTPException(404, "Meal not found")
    totals = meal["totals"]
    return {
        **meal,
        "health": health_score(totals, len(meal["analysis"]["foods"])),
        "macro_split": macro_split(totals),
    }


def _zero_if_missing(day_totals: dict[str, Any] | None) -> dict[str, Any]:
    if day_totals is None:
        return {"meals": 0, "calories": 0, "protein": 0.0, "carbs": 0.0, "fat": 0.0}
    return day_totals


def _today() -> str:
    return date.today().isoformat()


def _parse_day(value: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise HTTPException(400, "date must be formatted as YYYY-MM-DD") from exc
