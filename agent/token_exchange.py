"""token_exchange.py: the one server-side step SmartThings OAuth needs.

Kept apart from the agent on purpose (its own app, its own port): the agent
never sees SmartThings credentials, and this service never sees a conversation.

Why it exists: the public docs only describe a confidential client. The token
endpoint wants the client id and *secret* as HTTP Basic auth, and a secret can't live in a browser bundle.
PKCE without a secret exists on the platform but isn't documented for apps we
create. So the browser does the authorize
redirect itself, and posts the returned `code` here; this adds the secret,
forwards to SmartThings, and hands the tokens back. It stores nothing and logs
no token.

Usage:
    SMARTTHINGS_CLIENT_ID=... SMARTTHINGS_CLIENT_SECRET=... \\
    SMARTTHINGS_REDIRECT_URI=http://localhost:5173/ \\
    uv run python token_exchange.py          # http://127.0.0.1:8001
"""

import os
from dataclasses import dataclass

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# The host that issued the code (see AUTHORIZE_URL in the package's oauth.ts:
# the documented api.smartthings.com/oauth/authorize answered 403 on 13 Oct
# 2026, so sign-in goes through this host, as the SmartThings CLI's does).
# Server-to-server, so this host's lack of CORS headers doesn't matter.
TOKEN_URL = os.getenv("SMARTTHINGS_TOKEN_URL", "https://oauthin-regional.api.smartthings.com/oauth/token")
PORT = 8001

# What the browser may receive. Anything else SmartThings returns is dropped.
TOKEN_FIELDS = ("access_token", "refresh_token", "expires_in", "token_type", "scope")


@dataclass(frozen=True)
class Settings:
    client_id: str
    client_secret: str
    redirect_uri: str
    allowed_origins: tuple[str, ...]

    @classmethod
    def from_env(cls) -> "Settings":
        missing = [n for n in ("SMARTTHINGS_CLIENT_ID", "SMARTTHINGS_CLIENT_SECRET", "SMARTTHINGS_REDIRECT_URI") if not os.getenv(n)]
        if missing:
            raise SystemExit(f"Missing environment: {', '.join(missing)}")
        origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
        return cls(
            client_id=os.environ["SMARTTHINGS_CLIENT_ID"],
            client_secret=os.environ["SMARTTHINGS_CLIENT_SECRET"],
            redirect_uri=os.environ["SMARTTHINGS_REDIRECT_URI"],
            allowed_origins=tuple(o.strip() for o in origins.split(",") if o.strip()),
        )


class CodeExchange(BaseModel):
    code: str
    redirect_uri: str


class Refresh(BaseModel):
    refresh_token: str


def build_app(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    app = FastAPI(title="smartthings-agui token exchange")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_methods=["POST"],
        allow_headers=["Content-Type"],
    )

    async def forward(form: dict) -> dict:
        async with httpx.AsyncClient(transport=transport, timeout=15) as client:
            response = await client.post(
                TOKEN_URL,
                data={**form, "client_id": settings.client_id},
                auth=(settings.client_id, settings.client_secret),
            )
        if response.status_code != 200:
            # SmartThings' error body can echo request details; pass on only
            # the status and the OAuth error code.
            try:
                error = response.json().get("error", "token_error")
            except ValueError:
                error = "token_error"
            raise HTTPException(status_code=response.status_code if response.status_code < 500 else 502, detail=error)
        body = response.json()
        return {k: body[k] for k in TOKEN_FIELDS if k in body}

    @app.post("/oauth/token")
    async def exchange(request: CodeExchange) -> dict:
        # Only the registered redirect: this service mustn't become a generic
        # code-redeeming proxy for other redirect targets.
        if request.redirect_uri != settings.redirect_uri:
            raise HTTPException(status_code=400, detail="redirect_uri_mismatch")
        return await forward({"grant_type": "authorization_code", "code": request.code, "redirect_uri": request.redirect_uri})

    @app.post("/oauth/refresh")
    async def refresh(request: Refresh) -> dict:
        return await forward({"grant_type": "refresh_token", "refresh_token": request.refresh_token})

    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(build_app(Settings.from_env()), host="127.0.0.1", port=PORT)
