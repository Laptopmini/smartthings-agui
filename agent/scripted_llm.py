"""A deterministic stand-in for the chat model, for tests and the spike.

It plays the part a real model plays in the frontend-tool loop, so the AG-UI
round trip (agent calls a tool, the browser runs it, the result comes back,
the run finishes) can be checked without loading anything in LM Studio:

1. user asks "turn on <label>"   -> call list_devices {}
2. list_devices result (a list)  -> call set_switch {deviceId, state}
   ("lock"/"unlock <label>" -> confirm_command; "dim <label> to N" -> set_level)
3. that tool's result            -> reply with text, no tool call

It never sees SmartThings: it only reads the tool results the browser sent.
"""

import json
import re
import uuid

from llama_index.core.base.llms.types import ChatMessage, MessageRole
from llama_index.core.llms.llm import ToolSelection
from llama_index.core.llms.mock import MockFunctionCallingLLM


def _text(message: ChatMessage) -> str:
    return message.content or ""


def _call(name: str, kwargs: dict) -> ChatMessage:
    return ChatMessage(
        role=MessageRole.ASSISTANT,
        content="",
        additional_kwargs={
            "tool_calls": [
                ToolSelection(tool_id=f"call_{uuid.uuid4().hex[:12]}", tool_name=name, tool_kwargs=kwargs)
            ]
        },
    )


def _is_tool_result(message: ChatMessage) -> bool:
    # llama-index-protocols-ag-ui 0.5.0 converts an AG-UI `tool` message into a
    # *user* message carrying `tool_call_id` (its "opinionated hack" until core
    # supports tool messages), so the role alone can't identify a tool result.
    return message.role == MessageRole.TOOL or "tool_call_id" in message.additional_kwargs


# What the model was sent on the latest call, for tests to inspect.
LAST_MESSAGES: list[ChatMessage] = []


def respond(messages: list[ChatMessage], **_: object) -> ChatMessage:
    LAST_MESSAGES[:] = messages
    user = next(m for m in reversed(messages) if m.role == MessageRole.USER and not _is_tool_result(m))
    request = _text(user).lower()
    last = messages[-1]

    if not _is_tool_result(last):
        return _call("list_devices", {})

    result = _text(last)
    try:
        devices = json.loads(result)
    except json.JSONDecodeError:
        devices = None

    if isinstance(devices, list):
        state = "off" if re.search(r"\boff\b", request) else "on"
        # Longest label first, so "Tall Lamp Left" wins over "Tall Lamp".
        for device in sorted(devices, key=lambda d: -len(d.get("label", ""))):
            if device.get("label", "").lower() not in request:
                continue
            verb = re.search(r"\b(unlock|lock)\b", request)
            if verb:
                return _call(
                    "confirm_command",
                    {"deviceId": device["deviceId"], "capability": "lock", "command": verb.group(1)},
                )
            level = re.search(r"\bdim\b.*?\bto (\d+)", request)
            if level:
                # A string, as the router's flattened schema makes real models send.
                return _call("set_level", {"deviceId": device["deviceId"], "level": level.group(1)})
            return _call("set_switch", {"deviceId": device["deviceId"], "state": state})
        return ChatMessage(role=MessageRole.ASSISTANT, content="I couldn't find that device.")

    return ChatMessage(role=MessageRole.ASSISTANT, content=f"Done: {result}")


class ScriptedLLM(MockFunctionCallingLLM):
    def __init__(self) -> None:
        super().__init__(response_generator=respond, is_chat_model=True)
