"""serve.py: the reference AG-UI agent for smartthings-agui.

The agent holds no SmartThings code and no SmartThings credentials. Every
SmartThings capability arrives as a *frontend tool* in the AG-UI request
(`RunAgentInput.tools`); the LlamaIndex router passes those through to the
model and ends the run when the model calls one, so the browser executes it
and calls back with the result.

Usage:
    uv run python serve.py              # OpenAI-compatible model (see below)
    uv run python serve.py --scripted   # deterministic test double, no model

Environment (any OpenAI-compatible endpoint whose model supports native tool
calls; local servers such as LM Studio should work too but haven't been
tested yet):
    AGENT_API_BASE   the endpoint, e.g. https://api.openai.com/v1 (required)
    AGENT_API_KEY    the endpoint's key (required)
    AGENT_MODEL      the model name (required)
    AGENT_EXTRA_BODY optional JSON merged into each request body, for
                     provider-specific options (for example one that keeps a
                     reasoning model's thinking out of the chat reply).
    AGENT_HOST       interface to listen on (default 127.0.0.1)
    AGENT_ORIGINS    extra allowed browser origins, comma-separated
"""

import argparse
import json
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from router import ContextAwareRouter

# Loopback by default. To try the app from a phone on the same network, set
# AGENT_HOST=0.0.0.0 and add the page's origin to AGENT_ORIGINS.
HOST = os.getenv("AGENT_HOST", "127.0.0.1")
PORT = 8000

# Vite's dev server. The browser calls this agent directly (no Node runtime).
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
# Extra browser origins allowed to call the agent, comma-separated
# (e.g. http://192.168.1.20:5173 when testing from a phone).
EXTRA_ORIGINS = [o.strip() for o in os.getenv("AGENT_ORIGINS", "").split(",") if o.strip()]

SYSTEM_PROMPT = """\
You control the user's SmartThings home through tools that run in their browser.
- Use device and scene ids from the home context below or from list_devices; never invent ids.
- Prefer the typed tools (set_switch, set_level, set_color, set_thermostat); use
  execute_command only for other capabilities.
- Locks, doors, garage doors, valves and security systems: always use confirm_command,
  even if earlier in the conversation it was turned off. The app checks the user's
  safety settings and shows them a button in this chat. If it returns the device's
  state with confirmed: true, the command has run. "declined" means the user
  cancelled; disabled: true means that control is turned off and the user has
  already been shown how to turn it on, so just acknowledge it briefly.
- Scenes run through run_scene, which also asks the user with a button in this chat.
- When the user asks what devices, rooms or scenes they have, or asks to see them,
  use show_devices or show_scenes so they get cards; don't list them in text.
  After cards, reply with one short sentence.
- A device can take a few seconds to report a change. If a result has "pending",
  the command was accepted: say it's on its way and don't send it again.
- Never mention tool names, ids or other internals to the user.
- If a tool returns an error, explain it briefly in plain words or fix the arguments and retry once.
- After acting, answer in one short sentence based on the state the tool returned."""


def build_llm(scripted: bool):
    if scripted:
        from scripted_llm import ScriptedLLM

        return ScriptedLLM()

    from llama_index.llms.openai_like import OpenAILike

    missing = [n for n in ("AGENT_API_BASE", "AGENT_API_KEY", "AGENT_MODEL") if not os.getenv(n)]
    if missing:
        raise SystemExit(f"Set {', '.join(missing)} (any OpenAI-compatible endpoint), or run with --scripted.")
    extra_body = os.getenv("AGENT_EXTRA_BODY")

    return OpenAILike(
        model=os.environ["AGENT_MODEL"],
        api_base=os.environ["AGENT_API_BASE"],
        api_key=os.environ["AGENT_API_KEY"],
        is_chat_model=True,
        # Native tool calls: the router reads `tool_calls` back from the response.
        is_function_calling_model=True,
        context_window=32768,
        timeout=300,
        additional_kwargs={"extra_body": json.loads(extra_body)} if extra_body else {},
    )


def build_app(llm) -> FastAPI:
    app = FastAPI(title="smartthings-agui reference agent")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=DEV_ORIGINS + EXTRA_ORIGINS,
        allow_methods=["*"],
        # Every header, including `Authorization`: CopilotKit PR #7506's example
        # allowed a fixed list and its preflight returned 400 for that header.
        allow_headers=["*"],
    )
    # No backend tools: everything SmartThings is a frontend tool.
    app.include_router(ContextAwareRouter(llm, SYSTEM_PROMPT).router)

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "model": getattr(llm, "model", type(llm).__name__)}

    return app


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--scripted", action="store_true", help="use the scripted test LLM")
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    uvicorn.run(build_app(build_llm(args.scripted)), host=HOST, port=args.port)
