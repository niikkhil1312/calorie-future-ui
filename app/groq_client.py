"""Groq chat-completions client for meal photo analysis (vision model)."""

import base64

import httpx

SYSTEM_PROMPT = """You are an expert nutritionist with deep knowledge of global cuisines, \
especially Indian, South Asian, East Asian, Mediterranean, Mexican, American and European food, \
including vegetarian and vegan dishes.

Analyze the meal photo and return ONLY a valid JSON object. No markdown fences, no commentary.

Use exactly this structure:
{
  "foods": [
    {
      "name": "specific common name, e.g. 'Paneer Butter Masala' not 'curry'",
      "emoji": "one relevant emoji",
      "portion": "estimated portion, e.g. '1 katori (150 ml)', '2 rotis', '1 medium plate'",
      "calories": <number>,
      "protein": <grams, number>,
      "carbs": <grams, number>,
      "fat": <grams, number>
    }
  ],
  "totals": {"calories": <number>, "protein": <number>, "carbs": <number>, "fat": <number>},
  "micronutrients": [{"name": "nutrient", "amount": "estimate with unit"}],
  "notes": "one brief, specific health tip for this meal"
}

Rules:
- List every visible food item separately, including small items such as chutney, pickle or papad.
- Account for cooking oil, ghee, butter and cream. Do not underestimate fried or rich dishes.
- Use regional portion references (katori, roti count, cups) where they fit.
- Include 4 to 6 micronutrients that matter for this food.
- If no food can be identified, return exactly: {"error": "Could not identify food items in this image."}
- Output the JSON object and nothing else."""


class VisionError(RuntimeError):
    """Groq could not be reached or returned an unusable response."""


class VisionClient:
    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str,
        timeout: float = 60.0,
        transport: httpx.BaseTransport | None = None,
    ):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/") + "/"
        self.timeout = timeout
        self.transport = transport

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def analyze(self, image_jpeg: bytes, meal_name: str = "", portion: str = "regular") -> str:
        """Send one meal photo to the vision model and return the raw text reply."""
        if not self.configured:
            raise VisionError("GROQ_API_KEY is not set")

        user_text = f"Analyze this meal image. Portion size: {portion}."
        if meal_name:
            user_text += f' This meal is called "{meal_name}".'
        user_text += " Return the nutritional breakdown as JSON."

        image_url = "data:image/jpeg;base64," + base64.b64encode(image_jpeg).decode("ascii")
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {"type": "image_url", "image_url": {"url": image_url}},
                    ],
                },
            ],
            "temperature": 0.3,
            "max_completion_tokens": 2048,
        }

        try:
            with httpx.Client(
                base_url=self.base_url, timeout=self.timeout, transport=self.transport
            ) as client:
                response = client.post(
                    "chat/completions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json=payload,
                )
        except httpx.HTTPError as exc:
            raise VisionError(f"Could not reach Groq ({exc.__class__.__name__})") from exc

        if response.status_code >= 400:
            raise VisionError(f"Groq returned HTTP {response.status_code}: {_error_message(response)}")

        try:
            content = response.json()["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise VisionError("Unexpected response format from Groq") from exc
        return content or ""


def _error_message(response: httpx.Response) -> str:
    try:
        return str(response.json()["error"]["message"])[:300]
    except (KeyError, TypeError, ValueError):
        return response.text[:300]
