# 🥗 NutriLens: AI Food Calorie Tracker

Snap a photo of a meal and NutriLens estimates its calories, macronutrients and key micronutrients using Groq's vision model (Llama 4 Scout). Each meal is saved to a daily log, and a dashboard shows today's totals and the last 7 days.

- 📱 Mobile-first interface: calories-left hero, macro rings, week strip, photo meal cards and a meal detail page
- 🔐 Own sign-up and sign-in (email and password), with HttpOnly session cookies and per-user private logs
- 📸 Upload a meal photo (JPEG, PNG or WEBP, up to 10 MB), with optional meal name and portion size
- 🧠 AI identifies each food item with portion, calories, protein, carbs and fat
- 📊 Calorie and macro breakdown, macro split, balance score and micronutrients
- 🗂️ Daily meal log with thumbnails, delete, and a 7-day calorie chart
- 💾 Supabase (Postgres + Storage) for production, SQLite for local development
- 🐳 Docker and docker-compose support

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

## Configuration

All settings come from environment variables or `.env`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GROQ_API_KEY` | **Yes** | none | Your Groq API key |
| `STORAGE_BACKEND` | No | `supabase` if `SUPABASE_URL` is set, else `sqlite` | `supabase` or `sqlite` |
| `SUPABASE_URL` | With Supabase | none | Project URL, e.g. `https://xyz.supabase.co` |
| `SUPABASE_SERVICE_KEY` | With Supabase | none | Server-only secret key |
| `SUPABASE_BUCKET` | No | `meal-thumbnails` | Private Storage bucket for thumbnails |
| `DATABASE_PATH` | No | `data/nutrilens.db` | SQLite file (sqlite backend only) |
| `SESSION_DAYS` | No | `14` | How long a sign-in lasts |
| `COOKIE_SECURE` | No | `false` | Set `true` when served over HTTPS |
| `GROQ_MODEL` | No | `meta-llama/llama-4-scout-17b-16e-instruct` | Groq vision model ID |
| `GROQ_BASE_URL` | No | `https://api.groq.com/openai/v1` | Groq-compatible API base URL |
| `MAX_UPLOAD_MB` | No | `10` | Maximum upload size |

Groq model IDs change over time. If analysis fails with a model error, check the current list at console.groq.com and set `GROQ_MODEL`.

---

## API

All meal routes require a signed-in session. Every write also needs the header `X-Requested-With: NutriLens`, which the built-in frontend sends. Interactive docs are at `/docs` while the server runs.

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
| `403` | A write request without the `X-Requested-With: NutriLens` header |
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

## License

MIT
