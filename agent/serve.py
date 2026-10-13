"""serve.py: the reference AG-UI agent for smartthings-agui.

The agent holds no SmartThings code and no SmartThings credentials. Every
SmartThings capability arrives as a *frontend tool* in the AG-UI request
(`RunAgentInput.tools`); the LlamaIndex router passes those through to the
model and ends the run when the model calls one, so the browser executes it
and calls back with the result.

Usage:
    uv run python serve.py              # LM Studio (OpenAI-compatible)
    uv run python serve.py --scripted   # deterministic test double, no model

Environment (LM Studio mode):
    LMSTUDIO_API_BASE   default http://localhost:1234/v1
    LMSTUDIO_API_KEY    LM Studio's API key, if it has one
    SMARTTHINGS_AGUI_MODEL  default google/gemma-4-26b-a4b
"""

import argparse
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from llama_index.protocols.ag_ui.router import get_ag_ui_workflow_router

HOST = "127.0.0.1"
PORT = 8000

# Vite's dev server. The browser calls this agent directly (no Node runtime).
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]

DEFAULT_MODEL = "google/gemma-4-26b-a4b"

SYSTEM_PROMPT = """\
You control a SmartThings home through tools that run in the user's browser.
Call list_devices to find a device's id before acting on it; never invent ids.
To turn a switch on or off, call set_switch with that id.
After a tool returns, answer in one short sentence."""


def build_llm(scripted: bool):
    if scripted:
        from scripted_llm import ScriptedLLM

        return ScriptedLLM()

    from llama_index.llms.openai_like import OpenAILike

    return OpenAILike(
        model=os.getenv("SMARTTHINGS_AGUI_MODEL", DEFAULT_MODEL),
        api_base=os.getenv("LMSTUDIO_API_BASE", "http://localhost:1234/v1"),
        api_key=os.getenv("LMSTUDIO_API_KEY", "lm-studio"),
        is_chat_model=True,
        # Native tool calls: the router reads `tool_calls` back from the response.
        is_function_calling_model=True,
        context_window=32768,
        timeout=300,
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
    app.include_router(get_ag_ui_workflow_router(llm=llm, system_prompt=SYSTEM_PROMPT))

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
