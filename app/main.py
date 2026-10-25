"""Tell Me Calories FastAPI application: accounts, meal photo analysis, meal log and dashboard API."""

from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .auth import (
    DUMMY_HASH,
    SESSION_COOKIE,
    AuthError,
    RateLimiter,
    hash_password,
    hash_session_token,
    new_session_token,
    normalize_email,
    validate_password,
    verify_password,
)
from .config import Settings, get_settings
from .db import SqliteStore
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
from .store_errors import DuplicateEmail, StorageError
from .supabase_store import SupabaseStore

STATIC_DIR = Path(__file__).resolve().parent / "static"
PORTIONS = ("small", "regular", "large")
MEAL_TYPES = ("breakfast", "lunch", "dinner", "snack")
MAX_SUMMARY_DAYS = 31
MAX_MEAL_NAME = 80
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "TellMeCalories"


class Credentials(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=128)


def create_app(settings: Settings | None = None, vision: Any = None, store: Any = None) -> FastAPI:
    settings = settings or get_settings()
    if store is None:
        store = (
            SupabaseStore(settings.supabase_url, settings.supabase_service_key, settings.supabase_bucket)
            if settings.storage_backend == "supabase"
            else SqliteStore(settings.database_path)
        )
    vision = vision or VisionClient(
        api_key=settings.groq_api_key,
        model=settings.groq_model,
        base_url=settings.groq_base_url,
    )
    login_by_ip = RateLimiter(max_attempts=20, window_seconds=15 * 60)
    login_by_email = RateLimiter(max_attempts=5, window_seconds=15 * 60)
    signup_by_ip = RateLimiter(max_attempts=10, window_seconds=60 * 60)

    app = FastAPI(title="Tell Me Calories", version="3.0.0")

    if isinstance(store, SupabaseStore):
        store.ensure_bucket()

    @app.middleware("http")
    async def require_custom_header(request: Request, call_next):
        # Browsers only send custom headers from same-origin fetch calls. This blocks cross-site
        # form posts that the session cookie would otherwise authorise.
        if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
            if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
                return JSONResponse({"detail": "Missing request header"}, status_code=403)
        return await call_next(request)

    def current_user(request: Request) -> dict[str, str]:
        token = request.cookies.get(SESSION_COOKIE)
        user = store.get_session_user(hash_session_token(token)) if token else None
        if user is None:
            raise HTTPException(401, "Sign in to continue")
        return user

    def start_session(response: Response, user_id: str) -> None:
        token = new_session_token()
        expires_at = datetime.now(timezone.utc) + timedelta(days=settings.session_days)
        store.create_session(hash_session_token(token), user_id, expires_at.isoformat(timespec="seconds"))
        response.set_cookie(
            SESSION_COOKIE,
            token,
            max_age=settings.session_days * 24 * 3600,
            httponly=True,
            secure=settings.cookie_secure,
            samesite="lax",
            path="/",
        )

    # ── Health and accounts ──

    # HEAD is allowed because uptime monitors send it by default. A monitor that visits this
    # every few minutes also stops a free host from putting the app to sleep.
    @app.api_route("/api/health", methods=["GET", "HEAD"])
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "groq_configured": vision.configured,
            "model": vision.model,
            "storage": settings.storage_backend,
        }

    @app.post("/api/auth/signup", status_code=201)
    def signup(body: Credentials, request: Request, response: Response) -> dict[str, str]:
        if not signup_by_ip.hit(_client_ip(request)):
            raise HTTPException(429, "Too many sign-ups from this network. Try again later.")
        try:
            email = normalize_email(body.email)
            validate_password(body.password)
        except AuthError as exc:
            raise HTTPException(400, str(exc)) from exc
        try:
            user = store.create_user(str(uuid4()), email, hash_password(body.password))
        except DuplicateEmail as exc:
            raise HTTPException(409, "An account with this email already exists") from exc
        start_session(response, user["id"])
        return {"id": user["id"], "email": user["email"]}

    @app.post("/api/auth/login")
    def login(body: Credentials, request: Request, response: Response) -> dict[str, str]:
        ip_key = f"ip:{_client_ip(request)}"
        try:
            email = normalize_email(body.email)
        except AuthError:
            raise HTTPException(401, "Email or password is incorrect") from None
        email_key = f"email:{email}"
        if not login_by_ip.hit(ip_key) or not login_by_email.hit(email_key):
            raise HTTPException(429, "Too many sign-in attempts. Try again in 15 minutes.")

        user = store.get_user_by_email(email)
        # Always run one scrypt check, so unknown emails are not faster to reject.
        password_ok = verify_password(body.password, user["password_hash"] if user else DUMMY_HASH)
        if user is None or not password_ok:
            raise HTTPException(401, "Email or password is incorrect")

        login_by_email.reset(email_key)
        start_session(response, user["id"])
        return {"id": user["id"], "email": user["email"]}

    @app.post("/api/auth/logout", status_code=204)
    def logout(request: Request) -> Response:
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            store.delete_session(hash_session_token(token))
        response = Response(status_code=204)
        response.delete_cookie(SESSION_COOKIE, path="/")
        return response

    @app.get("/api/auth/me")
    def me(user: dict[str, str] = Depends(current_user)) -> dict[str, str]:
        return {"id": user["id"], "email": user["email"]}

    # ── Meals (all scoped to the signed-in user) ──

    @app.post("/api/meals/analyze", status_code=201)
    async def analyze_meal(
        file: UploadFile = File(...),
        meal_name: str = Form(""),
        portion: str = Form("regular"),
        meal_date: str | None = Form(None),
        meal_type: str | None = Form(None),
        user: dict[str, str] = Depends(current_user),
    ) -> dict[str, Any]:
        if not vision.configured:
            raise HTTPException(503, "GROQ_API_KEY is not set. Add it to .env and restart the server.")

        portion = portion.lower()
        if portion not in PORTIONS:
            raise HTTPException(400, "portion must be small, regular or large")
        meal_type = (meal_type or "").strip().lower() or None
        if meal_type is not None and meal_type not in MEAL_TYPES:
            raise HTTPException(400, "meal_type must be breakfast, lunch, dinner or snack")
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

        if meal_type:
            # Kept inside the analysis JSON so no database change is needed.
            analysis["meal_type"] = meal_type

        meal_id = str(uuid4())
        try:
            store.insert_meal(
                meal_id=meal_id,
                user_id=user["id"],
                meal_name=name or "Unnamed meal",
                portion=portion,
                meal_date=meal_day,
                model=vision.model,
                analysis=analysis,
                thumbnail=thumbnail,
            )
        except StorageError as exc:
            raise HTTPException(503, "Could not save the meal. Please try again.") from exc
        return _public_meal(store.get_meal(user["id"], meal_id))

    @app.get("/api/meals")
    def list_meals(
        day: str | None = Query(None, alias="date"),
        user: dict[str, str] = Depends(current_user),
    ) -> list[dict[str, Any]]:
        meal_day = _parse_day(day) if day else _today()
        return [_public_meal(meal) for meal in store.list_meals(user["id"], meal_day)]

    @app.get("/api/meals/{meal_id}")
    def get_meal(meal_id: str, user: dict[str, str] = Depends(current_user)) -> dict[str, Any]:
        return _public_meal(store.get_meal(user["id"], meal_id))

    @app.get("/api/meals/{meal_id}/thumbnail")
    def get_thumbnail(meal_id: str, user: dict[str, str] = Depends(current_user)) -> Response:
        content = store.get_thumbnail(user["id"], meal_id)
        if content is None:
            raise HTTPException(404, "Meal not found")
        return Response(
            content=content,
            media_type="image/jpeg",
            headers={"Cache-Control": "private, max-age=86400"},
        )

    @app.delete("/api/meals/{meal_id}", status_code=204)
    def delete_meal(meal_id: str, user: dict[str, str] = Depends(current_user)) -> Response:
        if not store.delete_meal(user["id"], meal_id):
            raise HTTPException(404, "Meal not found")
        return Response(status_code=204)

    @app.get("/api/summary")
    def summary(
        day: str | None = Query(None, alias="date"),
        days: int = Query(7, ge=1, le=MAX_SUMMARY_DAYS),
        user: dict[str, str] = Depends(current_user),
    ) -> dict[str, Any]:
        end_day = _parse_day(day) if day else _today()
        end = date.fromisoformat(end_day)
        start = (end - timedelta(days=days - 1)).isoformat()
        totals = store.daily_totals(user["id"], start, end_day)

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
        "thumbnail_url": f"/api/meals/{meal['id']}/thumbnail",
        "health": health_score(totals, len(meal["analysis"]["foods"])),
        "macro_split": macro_split(totals),
    }


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


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
