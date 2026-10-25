# 🥗 Tell Me Calories: AI Food Calorie Tracker

Snap a photo of a meal and Tell Me Calories estimates its calories, macronutrients and key nutrients using a vision model on Groq (default `qwen/qwen3.8-27b`). Each meal is saved to your private daily log.

- **Home:** a "calories left" hero with a week strip and day arrows, swipeable macro cards (grams left, then share of calories), and meals grouped into Breakfast, Lunch, Dinner and Snacks, plus a Nutrients tab
- **Add meal:** take or choose a photo, pick the meal type and portion, and watch the AI scan it
- **Meal detail:** photo hero, balance score, tall macro bars, every detected food and key nutrients
- **History:** your last 30 days, tap a day to open it
- **Progress:** 7, 14 or 30 day calorie chart against your goal, streak and average macros
- **Profile:** a daily calorie goal with matching macro targets
- Own sign-up and sign-in (email and password), HttpOnly session cookies, and per-user private logs
- Installable on a phone's home screen, with loading, empty and offline states throughout
- Supabase (Postgres and Storage) for production, SQLite for local development, Docker and Render support

**Nutrition figures are AI estimates from a photo.** They are not medical advice.

---

## Setup

You need a Groq API key (free at [console.groq.com](https://console.groq.com)) and, for production, a Supabase project.

### 1. Supabase (production storage)

1. Create a project at supabase.com.
2. Open **SQL Editor**, paste the contents of `supabase/schema.sql`, and run it.
3. Copy the **Project URL** and the **secret** key (Project Settings → API) into `.env` as `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.

The secret key bypasses row-level security, so it must stay on the server. Never put it in frontend code.

### 2. Run locally


```bash
git clone https://github.com/niikkhil1312/calorie-future-ui.git
cd calorie-future-ui

cp .env.example .env
# edit .env and set GROQ_API_KEY=gsk_...

python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt

uvicorn app.main:create_app --factory --port 8000
```

Open <http://localhost:8000>.

### Run with Docker

```bash
cp .env.example .env                 # then add GROQ_API_KEY
docker compose up --build
```

Open <http://localhost:8000>. With Supabase configured, meal data lives in Supabase and the container keeps no state.

---

## Deploy on Render (free tier)

The repo includes a `render.yaml` blueprint and a Docker image that is ready for Render.

1. Sign in at [render.com](https://render.com) with GitHub.
2. Click **New +**, then **Blueprint**, and choose this repository. Render reads `render.yaml`.
3. When asked for the secret values, enter `GROQ_API_KEY`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`. They are never stored in the repo.
4. Click **Apply** and wait for the build to finish.
5. Open the service URL and check `/api/health`. It should show `"groq_configured": true` and `"storage": "supabase"`.
6. Create an account, add a meal photo, and confirm it shows on the dashboard.

Good to know:

- **Free instances sleep when idle,** so the first visit after a quiet period is slow. A paid instance stays awake.
- **Run a single instance.** The sign-in rate limiter lives in memory, so each extra instance would have its own count.
- **The container trusts the proxy's `X-Forwarded-For` header** so rate limits apply per visitor. Only run it behind a proxy such as Render's, not exposed directly to the internet.
- **Supabase free projects can pause after a period of inactivity.** If the app starts returning storage errors, resume the project in the Supabase dashboard.

---

## Configuration

All settings come from environment variables or `.env`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GROQ_API_KEY` | **Yes** | none | Your Groq API key |
| `STORAGE_BACKEND` | No | `supabase` if `SUPABASE_URL` is set, else `sqlite` | `supabase` or `sqlite` |
| `SUPABASE_URL` | With Supabase | none | Project URL, e.g. `https://xyz.supabase.co` |
| `SUPABASE_SERVICE_KEY` | With Supabase | none | Server-only secret key |
| `SUPABASE_BUCKET` | No | `meal-thumbnails` | Private Storage bucket for thumbnails |
| `DATABASE_PATH` | No | `data/tell-me-calories.db` | SQLite file (sqlite backend only) |
| `SESSION_DAYS` | No | `14` | How long a sign-in lasts |
| `COOKIE_SECURE` | No | `false` | Set `true` when served over HTTPS |
| `GROQ_MODEL` | No | `qwen/qwen3.8-27b` | Groq vision model ID |
| `GROQ_BASE_URL` | No | `https://api.groq.com/openai/v1` | Groq-compatible API base URL |
| `MAX_UPLOAD_MB` | No | `10` | Maximum upload size |

Groq retires models regularly. The previous default, Llama 4 Scout, is no longer available, and the current default `qwen/qwen3.8-27b` was the model that accepted images when this was last checked. If analysis fails with "model does not exist" (HTTP 502), list the models your key can use at https://console.groq.com/docs/models and set `GROQ_MODEL` to a current vision-capable one.

---

## API

All meal routes require a signed-in session. Every write also needs the header `X-Requested-With: TellMeCalories`, which the built-in frontend sends. Interactive docs are at `/docs` while the server runs.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Status, whether the Groq key is configured, and the model in use |
| `POST` | `/api/auth/signup` | Create an account (`email`, `password`). Signs you in. |
| `POST` | `/api/auth/login` | Sign in. Sets the session cookie. |
| `POST` | `/api/auth/logout` | Sign out and revoke the session |
| `GET` | `/api/auth/me` | The signed-in user, or `401` |
| `POST` | `/api/meals/analyze` | Multipart form: `file`, `meal_name`, `portion` (small/regular/large), `meal_date` (YYYY-MM-DD). Analyses the photo and saves the meal. Returns `201`. |
| `GET` | `/api/meals?date=YYYY-MM-DD` | Meals logged on a day (defaults to today) |
| `GET` | `/api/meals/{id}` | One meal with its full analysis |
| `GET` | `/api/meals/{id}/thumbnail` | Thumbnail JPEG |
| `DELETE` | `/api/meals/{id}` | Delete a meal (`204`) |
| `GET` | `/api/summary?date=&days=7` | Day totals and a zero-filled daily series |

Error responses:

| Status | Meaning |
|---|---|
| `400` | Bad input: not an image, empty file, invalid portion, date, email or password |
| `401` | Not signed in, or the session has expired |
| `403` | A write request without the `X-Requested-With: TellMeCalories` header |
| `409` | Email already registered |
| `429` | Too many sign-up or sign-in attempts |
| `413` | File larger than `MAX_UPLOAD_MB` |
| `422` | The photo contains no identifiable food |
| `502` | Groq was unreachable, returned an error, or gave an unreadable reply |
| `503` | `GROQ_API_KEY` is not set |

---

## Project structure

```
app/
├── config.py          # Settings from environment and .env
├── main.py            # FastAPI app factory, routes, static frontend
├── groq_client.py     # Groq vision request, prompt and error handling
├── nutrition.py       # Parse model JSON, compute totals, health score, macro split
├── images.py          # Validate uploads, EXIF rotation, resize, thumbnails
├── auth.py            # scrypt passwords, session tokens, rate limiter
├── db.py              # SQLite storage backend (local dev and tests)
├── supabase_store.py  # Supabase storage backend (Postgres + Storage)
└── static/            # index.html, app.css, app.js (no build step)
tests/                 # pytest suite (Groq is mocked, no network needed)
supabase/schema.sql    # run once in the Supabase SQL Editor
Dockerfile
docker-compose.yml
render.yaml            # Render blueprint (free tier)
```

---

## Testing

```bash
pip install -r requirements-dev.txt
pytest
```

The suite covers JSON parsing and normalisation, totals and scoring, every API route and error path, the Groq client, account security (password hashing, sessions, rate limits, CSRF header, tenant isolation), and the Supabase backend's requests. Groq and Supabase are mocked, so the tests run offline.

---

## Notes and limitations

- **Security model.** Passwords are hashed with scrypt. Session tokens are random, stored only as SHA-256 hashes, and revocable on logout. Login is rate-limited per email and per IP. The limiter is per process, so run one instance or move it to shared storage before scaling out.
- **No email verification or password reset yet.** Both need an email provider.
- **Account enumeration.** Sign-up says when an email is already registered. Sign-in responses do not reveal which half was wrong.
- **Behind a proxy.** Rate limiting uses the client IP. Configure your proxy so uvicorn sees the real address, or all users share one limit.
- **Estimates vary.** Calorie values depend on what the model sees. Oil, ghee and hidden ingredients are hard to judge from a photo.
- **Balance score is a heuristic** based on macro ratios and food variety. It is not a clinical measure.

---

## Design

The palette follows the brand style guide (Pay Blue and Pal Blue as primary, Sand and Slate neutrals, Berry, Tangerine and Aqua for protein, carbs and fat). Type is [Lato](https://fonts.google.com/specifiedpage?query=Lato) (SIL Open Font License, bundled in `app/static/fonts`). Icons are from [Lucide](https://lucide.dev) (ISC license, bundled in `app/static/icons.js`).

---

## License

MIT
