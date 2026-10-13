"""The OAuth token-exchange service, against a fake SmartThings token endpoint."""

import base64
import sys
from pathlib import Path
from urllib.parse import parse_qs

import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from token_exchange import TOKEN_URL, Settings, build_app  # noqa: E402

SETTINGS = Settings(
    client_id="client-1",
    client_secret="s3cret",
    redirect_uris=("http://localhost:5173/", "https://192.168.1.20:5173/"),
    allowed_origins=("http://localhost:5173",),
)


def make_client(status: int = 200, body: dict | None = None):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            status,
            json=body
            if body is not None
            else {
                "access_token": "at",
                "refresh_token": "rt",
                "expires_in": 86399,
                "token_type": "bearer",
                "scope": "r:devices:*",
                "installed_app_id": "dropped",
            },
        )

    client = TestClient(build_app(SETTINGS, transport=httpx.MockTransport(handler)))
    return client, seen


def test_exchanges_a_code_with_basic_auth_and_returns_only_token_fields() -> None:
    client, seen = make_client()
    response = client.post("/oauth/token", json={"code": "abc", "redirect_uri": "http://localhost:5173/"})
    assert response.status_code == 200
    assert response.json() == {
        "access_token": "at",
        "refresh_token": "rt",
        "expires_in": 86399,
        "token_type": "bearer",
        "scope": "r:devices:*",
    }
    (request,) = seen
    assert str(request.url) == TOKEN_URL
    assert request.headers["authorization"] == "Basic " + base64.b64encode(b"client-1:s3cret").decode()
    assert parse_qs(request.content.decode()) == {
        "grant_type": ["authorization_code"],
        "code": ["abc"],
        "redirect_uri": ["http://localhost:5173/"],
        "client_id": ["client-1"],
    }


def test_refuses_other_redirect_uris_without_calling_smartthings() -> None:
    client, seen = make_client()
    response = client.post("/oauth/token", json={"code": "abc", "redirect_uri": "https://evil.example/"})
    assert response.status_code == 400
    assert seen == []


def test_refreshes() -> None:
    client, seen = make_client()
    assert client.post("/oauth/refresh", json={"refresh_token": "rt"}).status_code == 200
    assert parse_qs(seen[0].content.decode())["grant_type"] == ["refresh_token"]


def test_passes_on_only_the_oauth_error_code() -> None:
    client, _ = make_client(401, {"error": "invalid_grant", "error_description": "code abc was not found"})
    response = client.post("/oauth/token", json={"code": "abc", "redirect_uri": "http://localhost:5173/"})
    assert response.status_code == 401
    assert response.json() == {"detail": "invalid_grant"}


def test_cors_allows_only_the_app_origin() -> None:
    client, _ = make_client()
    ok = client.options(
        "/oauth/token", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"}
    )
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    other = client.options(
        "/oauth/token", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}
    )
    assert "access-control-allow-origin" not in other.headers


def test_accepts_each_registered_redirect_uri() -> None:
    client, seen = make_client()
    response = client.post("/oauth/token", json={"code": "abc", "redirect_uri": "https://192.168.1.20:5173/"})
    assert response.status_code == 200
    assert parse_qs(seen[0].content.decode())["redirect_uri"] == ["https://192.168.1.20:5173/"]
