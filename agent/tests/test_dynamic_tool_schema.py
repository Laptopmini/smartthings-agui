"""What the model sees for a frontend tool's parameters (Phase 0 item 3).

The router rebuilds each AG-UI tool as a pydantic model before handing it to
the LLM. This pins down what survives that step, because the plan is to
generate tool schemas from SmartThings capability definitions, and small local
models depend on enums and types to call tools correctly.
"""

from ag_ui.core import Tool
from llama_index.protocols.ag_ui.agent import _ag_ui_tool_to_llama_index

SET_LEVEL = Tool(
    name="set_level",
    description="Set a dimmer level.",
    parameters={
        "type": "object",
        "properties": {
            "deviceId": {"type": "string", "description": "Device id"},
            "state": {"type": "string", "enum": ["on", "off"], "description": "Switch state"},
            "level": {"type": "integer", "minimum": 0, "maximum": 100, "description": "Percent"},
        },
        "required": ["deviceId", "state", "level"],
    },
)


def test_router_flattens_every_parameter_to_string() -> None:
    """Documents current behaviour of llama-index-protocols-ag-ui 0.5.0.

    `enum`, `integer`, `minimum` and `maximum` are all dropped: the model sees
    three plain strings. If this test starts failing,
    upstream fixed it and the workaround (allowed values repeated in
    `description`) can go.
    """
    schema = _ag_ui_tool_to_llama_index(SET_LEVEL).metadata.get_parameters_dict()
    props = schema["properties"]

    assert props["deviceId"]["type"] == "string"
    assert props["state"]["type"] == "string"
    assert "enum" not in props["state"]
    assert props["level"]["type"] == "string"
    assert "maximum" not in props["level"]
    # Descriptions do survive, which is the workaround.
    assert props["state"]["description"] == "Switch state"
    assert sorted(schema["required"]) == ["deviceId", "level", "state"]
