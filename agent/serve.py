"""serve.py: the reference AG-UI agent for smartthings-agui.

The agent holds no SmartThings code and no SmartThings credentials. Every
SmartThings capability arrives as a *frontend tool* in the AG-UI request
(`RunAgentInput.tools`); the LlamaIndex router passes those through to the
model and ends the run when the model calls one, so the browser executes it
and calls back with the result.

Usage:
    uv run python serve.py              # OpenAI-compatible model (see below)
    uv run python serve.py --scripted   # deterministic test double, no model

Environment (any OpenAI-compatible endpoint). The defaults are the setup
that was tested; local models (e.g. LM Studio) should work the
same way but haven't been tested yet:
    AGENT_API_BASE   default https://api.example.com/v1
    AGENT_API_KEY    the endpoint's key (required)
    AGENT_MODEL      default example-model
    AGENT_EXTRA_BODY JSON merged into each request body, for provider
                     options. Example: {"example_option": true},
                     which keeps its <think> reasoning out of the chat reply.
"""

import argparse
import json
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from router import ContextAwareRouter

HOST = "127.0.0.1"
PORT = 8000

# Vite's dev server. The browser calls this agent directly (no Node runtime).
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]

DEFAULT_API_BASE = "https://api.example.com/v1"
DEFAULT_MODEL = "example-model"

SYSTEM_PROMPT = """\
You control the user's SmartThings home through tools that run in their browser.
- Use device and scene ids from the home context below or from list_devices; never invent ids.
- Prefer the typed tools (set_switch, set_level, set_color, set_thermostat); use
  execute_command only for other capabilities.
- Locks, doors, garage doors, valves and security systems need confirm_command.
  It shows the user a button in this chat; when it returns the device's state,
  the user has confirmed and the command has run, so report that state. If it
  returns "declined", the user cancelled. If confirm_command isn't available, say
  those controls are turned off in this app's safety settings; don't try other tools.
- Scenes run through run_scene, which also asks the user with a button in this chat.
- show_devices and show_scenes put cards in the chat that already show each device's
  state and controls. After them, reply with one short sentence; don't list the devices.
- If a tool returns an error, explain it briefly or fix the arguments and retry once.
- After acting, answer in one short sentence based on the state the tool returned."""


def build_llm(scripted: bool):
    if scripted:
        from scripted_llm import ScriptedLLM

        return ScriptedLLM()

    from llama_index.llms.openai_like import OpenAILike

    api_key = os.getenv("AGENT_API_KEY")
    if not api_key:
        raise SystemExit("Set AGENT_API_KEY (and AGENT_API_BASE/AGENT_MODEL for another provider).")
    api_base = os.getenv("AGENT_API_BASE", DEFAULT_API_BASE)
    extra_body = os.getenv("AGENT_EXTRA_BODY")
    if extra_body is None and "api.example.com" in api_base:
        extra_body = '{"example_option": true}'

    return OpenAILike(
        model=os.getenv("AGENT_MODEL", DEFAULT_MODEL),
        api_base=api_base,
        api_key=api_key,
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
        allow_origins=DEV_ORIGINS,
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
