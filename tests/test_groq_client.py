import json

import httpx
import pytest

from app.groq_client import VisionClient, VisionError


def make_client(handler, api_key="gsk_test"):
    return VisionClient(
        api_key=api_key,
        model="qwen/qwen3.8-27b",
        base_url="https://api.groq.com/openai/v1",
        transport=httpx.MockTransport(handler),
    )


def test_request_shape_and_auth_header():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"foods": []}'}}]})

    reply = make_client(handler).analyze(b"\xff\xd8fake-jpeg", meal_name="Dinner", portion="large")

    assert reply == '{"foods": []}'
    assert seen["url"] == "https://api.groq.com/openai/v1/chat/completions"
    assert seen["auth"] == "Bearer gsk_test"
    body = seen["body"]
    assert body["model"] == "qwen/qwen3.8-27b"
    user_content = body["messages"][1]["content"]
    assert 'called "Dinner"' in user_content[0]["text"]
    assert "Portion size: large" in user_content[0]["text"]
    assert user_content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_http_error_surfaces_groq_message():
    def handler(request):
        return httpx.Response(401, json={"error": {"message": "Invalid API Key"}})

    with pytest.raises(VisionError, match="HTTP 401: Invalid API Key"):
        make_client(handler).analyze(b"x")


def test_network_error_is_wrapped():
    def handler(request):
        raise httpx.ConnectError("boom", request=request)

    with pytest.raises(VisionError, match="Could not reach Groq"):
        make_client(handler).analyze(b"x")


def test_unexpected_payload_is_wrapped():
    def handler(request):
        return httpx.Response(200, json={"unexpected": True})

    with pytest.raises(VisionError, match="Unexpected response"):
        make_client(handler).analyze(b"x")


def test_missing_key_fails_before_any_request():
    def handler(request):
        raise AssertionError("no request should be sent without a key")

    client = make_client(handler, api_key="")
    assert client.configured is False
    with pytest.raises(VisionError, match="GROQ_API_KEY is not set"):
        client.analyze(b"x")
