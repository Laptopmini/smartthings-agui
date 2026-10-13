"""What the model receives: the stock router (duplicated prompt, dropped context) vs ours."""

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from llama_index.protocols.ag_ui.router import get_ag_ui_workflow_router

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import scripted_llm  # noqa: E402
from router import SYSTEM_MESSAGE_ID, ContextAwareRouter  # noqa: E402

PROMPT = "You control a home."

# A second run as CopilotKit sends it: the first run's snapshot echoed our
# system message back into the thread, after the user's message.
BODY = {
    "threadId": "t",
    "runId": "r2",
    "state": {},
    "messages": [
        {"id": "u1", "role": "user", "content": "hello"},
        {"id": "echo", "role": "system", "content": PROMPT},
    ],
    "tools": [],
    "context": [{"description": "The user's SmartThings home", "value": "Devices:\n- Desk Lamp id=dimmer: switch"}],
    "forwardedProps": {},
}


def seen_by_model(router) -> list:
    app = FastAPI()
    app.include_router(router)
    with TestClient(app).stream("POST", "/run", json=BODY) as response:
        assert response.status_code == 200
        for _ in response.iter_lines():
            pass
    return list(scripted_llm.LAST_MESSAGES)


def test_stock_router_duplicates_the_prompt_and_drops_context() -> None:
    """Pins the duplicated system prompt and the dropped context on llama-index-protocols-ag-ui 0.5.0.
    If this fails, upstream changed and router.py's shim may be removable."""
    messages = seen_by_model(get_ag_ui_workflow_router(llm=scripted_llm.ScriptedLLM(), system_prompt=PROMPT))
    system = [m for m in messages if m.role.value == "system"]
    assert len(system) == 2  # the prompt, twice
    assert not any("Desk Lamp" in (m.content or "") for m in messages)  # context dropped


def test_context_aware_router_sends_one_system_message_with_context() -> None:
    messages = seen_by_model(ContextAwareRouter(scripted_llm.ScriptedLLM(), PROMPT).router)
    system = [m for m in messages if m.role.value == "system"]
    assert len(system) == 1
    assert messages[0] is system[0]
    assert messages[0].additional_kwargs.get("id") == SYSTEM_MESSAGE_ID
    assert PROMPT in messages[0].content
    assert "## The user's SmartThings home\nDevices:\n- Desk Lamp id=dimmer: switch" in messages[0].content
    assert [m.content for m in messages[1:]][:1] == ["hello"]
