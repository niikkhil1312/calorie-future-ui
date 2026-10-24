"""Parse, validate and summarise the nutrition JSON returned by the model."""

import json
import re
from typing import Any

MACRO_KCAL = {"protein": 4, "carbs": 4, "fat": 9}
MAX_FOODS = 40
MAX_MICRONUTRIENTS = 12


class NutritionError(ValueError):
    """The model reply could not be turned into a nutrition analysis."""


class MealRejected(NutritionError):
    """The model reported that no food could be identified."""


def parse_model_json(raw: str) -> dict[str, Any]:
    """Extract the JSON object from a model reply, tolerating fences and stray text."""
    if not raw or not raw.strip():
        raise NutritionError("The model returned an empty response")

    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip()).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            raise NutritionError("The model response did not contain JSON") from None
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise NutritionError("The model response contained invalid JSON") from exc

    if not isinstance(data, dict):
        raise NutritionError("The model response was not a JSON object")
    return data


def normalize_analysis(data: dict[str, Any]) -> dict[str, Any]:
    """Clean the model output and compute totals from the individual foods."""
    error = data.get("error")
    if isinstance(error, str) and error.strip():
        raise MealRejected(error.strip()[:300])

    raw_foods = data.get("foods")
    if not isinstance(raw_foods, list):
        raise NutritionError("The model response contained no food list")

    foods = [_normalize_food(item) for item in raw_foods[:MAX_FOODS] if isinstance(item, dict)]
    if not foods:
        raise NutritionError("The model response contained no usable food items")

    totals = {
        "calories": round(sum(food["calories"] for food in foods)),
        "protein": round(sum(food["protein"] for food in foods), 1),
        "carbs": round(sum(food["carbs"] for food in foods), 1),
        "fat": round(sum(food["fat"] for food in foods), 1),
    }

    micronutrients = []
    raw_micros = data.get("micronutrients")
    for item in raw_micros if isinstance(raw_micros, list) else []:
        if len(micronutrients) >= MAX_MICRONUTRIENTS:
            break
        if isinstance(item, dict):
            name = _text(item.get("name"), "", 60)
            if name:
                micronutrients.append({"name": name, "amount": _text(item.get("amount"), "", 60)})

    return {
        "foods": foods,
        "totals": totals,
        "micronutrients": micronutrients,
        "notes": _text(data.get("notes"), "", 300),
    }


def health_score(totals: dict[str, float], food_count: int) -> dict[str, Any]:
    """Heuristic 0-100 balance score. It is a guide, not a clinical measure."""
    protein_kcal = totals["protein"] * MACRO_KCAL["protein"]
    carbs_kcal = totals["carbs"] * MACRO_KCAL["carbs"]
    fat_kcal = totals["fat"] * MACRO_KCAL["fat"]
    total_kcal = protein_kcal + carbs_kcal + fat_kcal
    if total_kcal == 0:
        return {"score": 50, "label": "No macro data to score this meal"}

    protein_pct = protein_kcal / total_kcal * 100
    carbs_pct = carbs_kcal / total_kcal * 100
    fat_pct = fat_kcal / total_kcal * 100

    score = 100
    if protein_pct < 10:
        score -= 20
    elif protein_pct > 40:
        score -= 10
    if fat_pct > 45:
        score -= 20
    elif fat_pct > 35:
        score -= 10
    if carbs_pct > 70:
        score -= 15
    if food_count >= 4:
        score += 5
    score = max(20, min(100, score))

    if score >= 80:
        label = "Well-balanced meal with good macro distribution"
    elif score >= 60:
        label = "Decent balance, could use more protein or fibre"
    else:
        label = "Consider more protein and less fat or refined carbs"
    return {"score": score, "label": label}


def macro_split(totals: dict[str, float]) -> dict[str, float]:
    """Share of calories from protein, carbs and fat, as percentages."""
    kcal = {key: totals[key] * factor for key, factor in MACRO_KCAL.items()}
    total = sum(kcal.values())
    if total == 0:
        return {"protein_pct": 0.0, "carbs_pct": 0.0, "fat_pct": 0.0}
    return {
        "protein_pct": round(kcal["protein"] / total * 100, 1),
        "carbs_pct": round(kcal["carbs"] / total * 100, 1),
        "fat_pct": round(kcal["fat"] / total * 100, 1),
    }


def _normalize_food(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": _text(item.get("name"), "Unknown food", 80),
        "emoji": _text(item.get("emoji"), "🍽️", 8),
        "portion": _text(item.get("portion"), "1 serving", 80),
        "calories": _number(item.get("calories")),
        "protein": _number(item.get("protein")),
        "carbs": _number(item.get("carbs")),
        "fat": _number(item.get("fat")),
    }


def _number(value: Any) -> float:
    """Accept numbers and numeric strings such as '~120 kcal'. Anything else is zero."""
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    if isinstance(value, str):
        match = re.search(r"\d+(?:\.\d+)?", value)
        if match:
            return float(match.group(0))
    return 0.0


def _text(value: Any, default: str, limit: int) -> str:
    if not isinstance(value, str):
        return default
    cleaned = " ".join(value.split())[:limit]
    return cleaned or default
