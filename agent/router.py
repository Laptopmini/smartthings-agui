"""The LlamaIndex AG-UI router with three fixes, until they land upstream.

1. Duplicated system prompt: the router's MESSAGES_SNAPSHOT echoes its own system
prompt back to the client, which resends it, and the router prepends another,
so the model sees one more copy every run.

2. Ignored context: the router ignores `RunAgentInput.context`, so anything the app shares
with `useAgentContext` (here, the device and scene list) never reaches the
model.

3. Tool history as text: the router converts earlier tool calls into `<tool_call>...</tool_call>`
text in the assistant message and tool results into *user* messages. Models
then copy that text instead of making native tool calls: the model tested did so 3
out of 3 times on the second request of a conversation, so every turn after
the first silently did nothing. `to_llama_message` below converts them into
native tool-call blocks and `tool` messages instead.

1 and 2 are fixed on the way in: drop every system message the client sent
(the app sends none of its own; any it has are echoes of ours), then put a
single system message first holding the system prompt and the app's context.
The workflow gets no `system_prompt` of its own, so it adds nothing.

Each problem is pinned against the stock router (tests/test_router_shim.py,
tests/test_tool_history.py), so a release that fixes one shows up as a
failing test, and the matching fix here can go.
"""

import json
import os
from pathlib import Path

import llama_index.protocols.ag_ui.agent as agui_agent
from ag_ui.core import AssistantMessage, Message, RunAgentInput, SystemMessage, ToolMessage
from llama_index.core.base.llms.types import ChatMessage, TextBlock, ToolCallBlock
from llama_index.protocols.ag_ui.agent import AGUIChatWorkflow
from llama_index.protocols.ag_ui.router import AGUIWorkflowRouter

_stock_to_llama_message = agui_agent.ag_ui_message_to_llama_index_message


def to_llama_message(message: Message) -> ChatMessage:
    """AG-UI → LlamaIndex, with tool calls and results kept native (problem 3 above).

    Everything else goes through the stock converter. The extra keys
    (`id`, `ag_ui_tool_calls`, `tool_call_id`) are the ones the router's
    reverse conversion reads, so snapshots still round-trip.
    """
    if isinstance(message, AssistantMessage) and message.tool_calls:
        blocks = [TextBlock(text=message.content)] if message.content else []
        for call in message.tool_calls:
            try:
                kwargs = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError:
                kwargs = {}
            blocks.append(ToolCallBlock(tool_call_id=call.id, tool_name=call.function.name, tool_kwargs=kwargs))
        return ChatMessage(
            role="assistant",
            blocks=blocks,
            additional_kwargs={
                "id": message.id,
                "ag_ui_tool_calls": [
                    {"id": c.id, "name": c.function.name, "arguments": c.function.arguments} for c in message.tool_calls
                ],
            },
        )
    if isinstance(message, ToolMessage):
        return ChatMessage(
            role="tool",
            content=message.content,
            additional_kwargs={"id": message.id, "tool_call_id": message.tool_call_id},
        )
    return _stock_to_llama_message(message)


# The workflow looks the converter up in its own module at call time, so
# replacing it there is enough. Process-wide, which is fine for this agent:
# it serves only this router.
agui_agent.ag_ui_message_to_llama_index_message = to_llama_message

# Stable id, so the echoed copy replaces itself in the client's thread instead
# of piling up beside the user's messages.
SYSTEM_MESSAGE_ID = "smartthings-agui-system"


def prepare_input(input: RunAgentInput, system_prompt: str) -> RunAgentInput:
    sections = [system_prompt]
    for item in input.context or []:
        sections.append(f"## {item.description}\n{item.value}")
    messages = [m for m in input.messages if m.role != "system"]
    system = SystemMessage(id=SYSTEM_MESSAGE_ID, role="system", content="\n\n".join(sections))
    return input.model_copy(update={"messages": [system, *messages]})


class ContextAwareRouter(AGUIWorkflowRouter):
    def __init__(self, llm, system_prompt: str, timeout: float = 120):
        async def workflow_factory():
            return AGUIChatWorkflow(llm=llm, timeout=timeout)

        self.system_prompt = system_prompt
        super().__init__(workflow_factory)

    # Same signature as the parent: FastAPI reads it to parse the body.
    async def run(self, input: RunAgentInput):
        # Opt-in request log for diagnosing model behaviour: one JSON line per
        # run. It holds the conversation and tool results (device names, ids,
        # states) but never the SmartThings token, which the agent never sees.
        if log := os.getenv("AGENT_REQUEST_LOG"):
            with Path(log).open("a") as f:
                f.write(input.model_dump_json(by_alias=True) + "\n")
        return await super().run(prepare_input(input, self.system_prompt))
