"""The frontend-tool loop over HTTP, as an AG-UI client drives it.

No model and no SmartThings: the scripted LLM stands in for the model and the
test stands in for the browser, sending the tool results back itself. The
browser half (CopilotKit actually executing the tool) is covered by
packages/smartthings-agui's integration test against this same server.
"""

import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripted_llm import ScriptedLLM  # noqa: E402
from serve import build_app  # noqa: E402

TOOLS = [
    {
        "name": "list_devices",
        "description": "List the user's SmartThings devices.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "set_switch",
        "description": "Turn a switch on or off.",
        "parameters": {
            "type": "object",
            "properties": {
                "deviceId": {"type": "string", "description": "Device id from list_devices"},
                "state": {"type": "string", "enum": ["on", "off"]},
            },
            "required": ["deviceId", "state"],
        },
    },
]

DEVICES = [
    {"deviceId": "dev-1", "label": "Tall Lamp"},
    {"deviceId": "dev-2", "label": "Tall Lamp Left"},
]


def run(client: TestClient, messages: list[dict]) -> list[dict]:
    body = {
        "threadId": "t1",
        "runId": f"r{len(messages)}",
        "state": {},
        "messages": messages,
        "tools": TOOLS,
        "context": [],
        "forwardedProps": {},
    }
    with client.stream("POST", "/run", json=body) as response:
        assert response.status_code == 200
        lines = [line for line in response.iter_lines() if line.startswith("data:")]
    return [json.loads(line[5:]) for line in lines]


def tool_calls(events: list[dict]) -> list[tuple[str, dict]]:
    """(name, args) per call, reassembled from TOOL_CALL_CHUNK/START/ARGS events."""
    calls: dict[str, dict] = {}
    for e in events:
        if e["type"] in ("TOOL_CALL_CHUNK", "TOOL_CALL_START"):
            call = calls.setdefault(e["toolCallId"], {"name": None, "args": ""})
            call["name"] = call["name"] or e.get("toolCallName")
        if e["type"] in ("TOOL_CALL_CHUNK", "TOOL_CALL_ARGS"):
            calls[e["toolCallId"]]["args"] += e.get("delta") or ""
    return [(c["name"], json.loads(c["args"] or "{}")) for c in calls.values()]


def call_id(events: list[dict]) -> str:
    return next(e["toolCallId"] for e in events if e["type"] in ("TOOL_CALL_CHUNK", "TOOL_CALL_START"))


def assistant_call(id_: str, name: str, args: dict) -> dict:
    return {
        "id": f"a-{id_}",
        "role": "assistant",
        "toolCalls": [{"id": id_, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}],
    }


def test_three_runs_complete_the_loop() -> None:
    client = TestClient(build_app(ScriptedLLM()))
    history = [{"id": "u1", "role": "user", "content": "Turn on Tall Lamp Left"}]

    # Run 1: the model calls a frontend tool; the run must end so the client can execute it.
    events = run(client, history)
    assert events[-1]["type"] == "RUN_FINISHED"
    assert tool_calls(events) == [("list_devices", {})]
    # The server must not answer a frontend call itself (that would stop the
    # client from running its handler).
    snapshot = [e for e in events if e["type"] == "MESSAGES_SNAPSHOT"][-1]
    assert not any(m["role"] == "tool" for m in snapshot["messages"])

    # Run 2: the client sends the tool result; the model picks the device.
    id1 = call_id(events)
    history += [
        assistant_call(id1, "list_devices", {}),
        {"id": "t-1", "role": "tool", "toolCallId": id1, "content": json.dumps(DEVICES)},
    ]
    events = run(client, history)
    assert events[-1]["type"] == "RUN_FINISHED"
    assert tool_calls(events) == [("set_switch", {"deviceId": "dev-2", "state": "on"})]

    # Run 3: the switch result comes back; the model answers and no tool is called.
    id2 = call_id(events)
    history += [
        assistant_call(id2, "set_switch", {"deviceId": "dev-2", "state": "on"}),
        {"id": "t-2", "role": "tool", "toolCallId": id2, "content": '{"switch":"on"}'},
    ]
    events = run(client, history)
    assert events[-1]["type"] == "RUN_FINISHED"
    assert tool_calls(events) == []
    text = "".join(e.get("delta", "") for e in events if e["type"].startswith("TEXT_MESSAGE"))
    assert "Done" in text
