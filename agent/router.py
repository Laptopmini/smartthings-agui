"""The LlamaIndex AG-UI router with two input fixes, until they land upstream.

1. Duplicated system prompt: the router's MESSAGES_SNAPSHOT echoes its own system
prompt back to the client, which resends it, and the router prepends another,
so the model sees one more copy every run.

2. Ignored context: the router ignores `RunAgentInput.context`, so anything the app shares
with `useAgentContext` (here, the device and scene list) never reaches the
model.

Both are fixed on the way in: drop every system message the client sent (the
app sends none of its own; any it has are echoes of ours), then put a single
system message first holding the system prompt and the app's context. The
workflow gets no `system_prompt` of its own, so it adds nothing.
"""

from ag_ui.core import RunAgentInput, SystemMessage
from llama_index.protocols.ag_ui.agent import AGUIChatWorkflow
from llama_index.protocols.ag_ui.router import AGUIWorkflowRouter

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
        return await super().run(prepare_input(input, self.system_prompt))
