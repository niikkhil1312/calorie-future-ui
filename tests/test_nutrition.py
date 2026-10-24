import pytest

from app.nutrition import (
    MealRejected,
    NutritionError,
    health_score,
    macro_split,
    normalize_analysis,
    parse_model_json,
)


def test_parse_strips_markdown_fences():
    data = parse_model_json('```json\n{"foods": []}\n```')
    assert data == {"foods": []}


def test_parse_extracts_object_surrounded_by_text():
    data = parse_model_json('Here you go: {"foods": [{"name": "Idli"}]} hope it helps')
    assert data["foods"][0]["name"] == "Idli"


@pytest.mark.parametrize("raw", ["", "   ", "no json here", "[1, 2, 3]", '{"foods": [}'])
def test_parse_rejects_unusable_replies(raw):
    with pytest.raises(NutritionError):
        parse_model_json(raw)


def test_normalize_computes_totals_from_foods():
    analysis = normalize_analysis({
        "foods": [
            {"name": "Rice", "calories": 200, "protein": 4, "carbs": 44, "fat": 0.5},
            {"name": "Chicken", "calories": 150, "protein": 28, "carbs": 0, "fat": 3},
        ],
        "totals": {"calories": 999},  # model totals are ignored in favour of the sum
    })
    assert analysis["totals"] == {"calories": 350, "protein": 32.0, "carbs": 44.0, "fat": 3.5}


def test_normalize_accepts_numeric_strings_and_drops_negative_values():
    analysis = normalize_analysis({
        "foods": [{"name": "Samosa", "calories": "~250 kcal", "protein": -5, "carbs": "n/a", "fat": 12}],
    })
    food = analysis["foods"][0]
    assert food["calories"] == 250
    assert food["protein"] == 0
    assert food["carbs"] == 0


def test_normalize_fills_missing_names_and_limits_micronutrients():
    micros = [{"name": f"N{i}", "amount": "1 mg"} for i in range(30)]
    analysis = normalize_analysis({
        "foods": [{"calories": 100}],
        "micronutrients": micros,
        "notes": "x" * 500,
    })
    assert analysis["foods"][0]["name"] == "Unknown food"
    assert len(analysis["micronutrients"]) == 12
    assert len(analysis["notes"]) == 300


def test_error_reply_raises_meal_rejected():
    with pytest.raises(MealRejected, match="Could not identify"):
        normalize_analysis({"error": "Could not identify food items in this image."})


def test_missing_food_list_is_an_error():
    with pytest.raises(NutritionError):
        normalize_analysis({"totals": {}})


def test_macro_split_sums_to_about_100():
    split = macro_split({"protein": 25, "carbs": 60, "fat": 15})
    assert split["protein_pct"] + split["carbs_pct"] + split["fat_pct"] == pytest.approx(100, abs=0.2)


def test_macro_split_handles_empty_meal():
    assert macro_split({"protein": 0, "carbs": 0, "fat": 0}) == {
        "protein_pct": 0.0, "carbs_pct": 0.0, "fat_pct": 0.0,
    }


def test_health_score_rewards_balance_and_variety():
    balanced = health_score({"protein": 30, "carbs": 50, "fat": 15}, food_count=4)
    fatty = health_score({"protein": 5, "carbs": 10, "fat": 60}, food_count=1)
    assert balanced["score"] > fatty["score"]
    assert 20 <= fatty["score"] <= 100


def test_health_score_without_macros_is_neutral():
    assert health_score({"protein": 0, "carbs": 0, "fat": 0}, food_count=1)["score"] == 50
