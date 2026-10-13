"""How earlier tool calls and results reach the model."""

import sys
from pathlib import Path

from ag_ui.core import AssistantMessage, FunctionCall, ToolCall, ToolMessage
from llama_index.core.base.llms.types import ToolCallBlock
from llama_index.llms.openai.utils import to_openai_message_dicts
from llama_index.protocols.ag_ui.utils import (
    ag_ui_message_to_llama_index_message,
    llama_index_message_to_ag_ui_message,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from router import to_llama_message  # noqa: E402

CALL = AssistantMessage(
    id="a1",
    role="assistant",
    content="Checking.",
    tool_calls=[
        ToolCall(id="call_1", type="function", function=FunctionCall(name="set_level", arguments='{"deviceId":"d","level":25}'))
    ],
)
RESULT = ToolMessage(id="t1", role="tool", tool_call_id="call_1", content='{"state":{"level":25}}')


def test_stock_converter_turns_tool_history_into_text() -> None:
    """Pins the stock conversion on llama-index-protocols-ag-ui 0.5.0; if this fails, upstream
    changed and the converter in router.py may be removable."""
    call = ag_ui_message_to_llama_index_message(CALL)
    result = ag_ui_message_to_llama_index_message(RESULT)
    assert "<tool_call><name>set_level</name>" in call.content
    assert not any(isinstance(b, ToolCallBlock) for b in call.blocks)
    assert result.role.value == "user"


def test_native_converter_sends_openai_tool_calls_and_tool_messages() -> None:
    dicts = to_openai_message_dicts([to_llama_message(CALL), to_llama_message(RESULT)])
    assert dicts[0]["role"] == "assistant"
    assert dicts[0]["tool_calls"][0]["id"] == "call_1"
    assert dicts[0]["tool_calls"][0]["function"]["name"] == "set_level"
    assert "<tool_call>" not in str(dicts[0].get("content"))
    assert dicts[1] == {"role": "tool", "content": '{"state":{"level":25}}', "tool_call_id": "call_1"}


def test_native_messages_round_trip_through_snapshots() -> None:
    """The router's reverse conversion (used for MESSAGES_SNAPSHOT) gives the
    client back the same tool call and result."""
    call = llama_index_message_to_ag_ui_message(to_llama_message(CALL))
    result = llama_index_message_to_ag_ui_message(to_llama_message(RESULT))
    assert call.id == "a1" and call.tool_calls[0].id == "call_1"
    assert call.tool_calls[0].function.arguments == '{"deviceId":"d","level":25}'
    assert result.id == "t1" and result.tool_call_id == "call_1"
