# 🥗 NutriLens: AI Food Calorie Tracker

Snap a photo of a meal and NutriLens estimates its calories, macronutrients and key micronutrients using Groq's vision model (Llama 4 Scout). Each meal is saved to a daily log, and a dashboard shows today's totals and the last 7 days.

- 📸 Upload a meal photo (JPEG, PNG or WEBP, up to 10 MB), with optional meal name and portion size
- 🧠 AI identifies each food item with portion, calories, protein, carbs and fat
- 📊 Calorie and macro breakdown, macro split, balance score and micronutrients
- 🗂️ Daily meal log with thumbnails, delete, and a 7-day calorie chart
- 💾 Persistent storage in SQLite, so the log survives restarts
- 🐳 Docker and docker-compose support

**Nutrition figures are AI estimates from a photo.** They are not medical advice.

---

## Quick start

You only need a Groq API key. It's free at [console.groq.com](https://console.groq.com) (keys start with `gsk_`).

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

Open <http://localhost:8000>. Meal data is stored in the `nutrilens-data` Docker volume.

---

## Configuration

All settings come from environment variables or `.env`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GROQ_API_KEY` | **Yes** | none | Your Groq API key |
| `GROQ_MODEL` | No | `meta-llama/llama-4-scout-17b-16e-instruct` | Groq vision model ID |
| `GROQ_BASE_URL` | No | `https://api.groq.com/openai/v1` | Groq-compatible API base URL |
| `DATABASE_PATH` | No | `data/nutrilens.db` | SQLite file location |
| `MAX_UPLOAD_MB` | No | `10` | Maximum upload size |

Groq model IDs change over time. If analysis fails with a model error, check the current list at console.groq.com and set `GROQ_MODEL`.

---

## API

Interactive docs are at `/docs` while the server runs.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Status, whether the Groq key is configured, and the model in use |
| `POST` | `/api/meals/analyze` | Multipart form: `file`, `meal_name`, `portion` (small/regular/large), `meal_date` (YYYY-MM-DD). Analyses the photo and saves the meal. Returns `201`. |
| `GET` | `/api/meals?date=YYYY-MM-DD` | Meals logged on a day (defaults to today) |
| `GET` | `/api/meals/{id}` | One meal with its full analysis |
| `GET` | `/api/meals/{id}/thumbnail` | Thumbnail JPEG |
| `DELETE` | `/api/meals/{id}` | Delete a meal (`204`) |
| `GET` | `/api/summary?date=&days=7` | Day totals and a zero-filled daily series |

Error responses:

| Status | Meaning |
|---|---|
| `400` | Bad input: not an image, empty file, invalid portion or date |
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
├── db.py              # SQLite meal store and daily aggregates
└── static/            # index.html, app.css, app.js (no build step)
tests/                 # pytest suite (Groq is mocked, no network needed)
Dockerfile
docker-compose.yml
```

---

## Testing

```bash
pip install -r requirements-dev.txt
pytest
```

The suite covers JSON parsing and normalisation, totals and scoring, every API route and error path, and the Groq client's request shape and error handling. Groq is mocked, so the tests run offline.

---

## Notes and limitations

- **No authentication.** NutriLens is built as a single-user tool. Before exposing it on a network, put it behind a reverse proxy with authentication or a VPN.
- **Estimates vary.** Calorie values depend on what the model sees. Oil, ghee and hidden ingredients are hard to judge from a photo.
- **Balance score is a heuristic** based on macro ratios and food variety. It is not a clinical measure.

---

## License

MIT
