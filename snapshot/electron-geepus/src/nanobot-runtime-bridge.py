#!/usr/bin/env python3
"""Geepus -> Nanobot native runtime bridge.

Reads JSON payload from stdin and emits JSON lines on stdout:
- {"type":"progress","content":"...","toolHint":false}
- {"type":"result","content":"..."}
- {"type":"error","error":"..."}
"""

from __future__ import annotations

import asyncio
import json
import sys
import traceback
from types import MethodType
from pathlib import Path
from typing import Any


def emit(event_type: str, **fields: Any) -> None:
    payload = {"type": event_type, **fields}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def compact_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    for msg in messages or []:
      role = str(msg.get("role", "") or "").strip()
      if not role:
          continue
      item: dict[str, Any] = {"role": role}
      if isinstance(msg.get("content"), str) and msg.get("content"):
          content = str(msg.get("content"))
          item["content"] = content[:4000]
      if role == "assistant" and isinstance(msg.get("tool_calls"), list):
          item["tool_calls"] = [
              {
                  "id": str(tc.get("id", "") or ""),
                  "name": str((tc.get("function") or {}).get("name", "") or ""),
                  "arguments": str((tc.get("function") or {}).get("arguments", "") or "")[:2000],
              }
              for tc in msg.get("tool_calls") or []
              if isinstance(tc, dict)
          ][:20]
      if role == "tool":
          item["name"] = str(msg.get("name", "") or "")
          item["tool_call_id"] = str(msg.get("tool_call_id", "") or "")
      compact.append(item)
    return compact[-80:]


def safe_json_text(value: Any, limit: int = 4000) -> str:
    try:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    text = str(text)
    return text[:limit]


def classify_exec_command(params: dict[str, Any]) -> tuple[str, str]:
    command = str((params or {}).get("command", "") or "").strip().lower()
    args = (params or {}).get("args", [])
    arg_text = " ".join(str(item or "").strip().lower() for item in args) if isinstance(args, list) else ""
    haystack = f"{command} {arg_text}".strip()
    if any(token in haystack for token in ("pytest", "jest", "vitest", "playwright", "xctest", "ctest", "swift test", "npm test", "pnpm test", "yarn test", "cargo test", "go test")):
        return "verifying", haystack
    if any(token in haystack for token in ("lint", "check", "verify", "validate", "qa")):
        return "verifying", haystack
    if any(token in haystack for token in ("build", "compile", "make", "npm run", "pnpm", "yarn", "cargo", "go build", "swift build")):
        return "executing", haystack
    return "executing", haystack


def detect_phase_from_progress(message: str, current_phase: str) -> str | None:
    text = str(message or "").strip().lower()
    if not text:
        return None
    if any(token in text for token in ("verify", "verification", "test", "qa", "validate", "checking")):
        return "verifying"
    if any(token in text for token in ("final answer", "final response", "wrap up", "complete", "completed", "done")):
        return "acceptance"
    if any(token in text for token in ("edit", "write", "patch", "implement", "build", "create", "run", "execute")):
        return "executing"
    if current_phase == "planning" and any(token in text for token in ("plan", "analy", "inspect", "reviewing files", "thinking", "investigating")):
        return "planning"
    return None


def fail(message: str, exit_code: int = 1) -> int:
    emit("error", error=message)
    return exit_code


def load_payload() -> dict[str, Any]:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return {}
        return json.loads(raw)
    except Exception as exc:
        raise ValueError(f"Invalid JSON payload: {exc}") from exc


def ensure_python_version() -> None:
    major, minor = sys.version_info[:2]
    if major < 3 or (major == 3 and minor < 11):
        raise RuntimeError(
            f"Python 3.11+ required for Nanobot runtime; found {major}.{minor}."
        )


def build_provider(payload: dict[str, Any]):
    provider = str(payload.get("provider", "openai") or "openai").strip().lower()
    api_key = str(payload.get("apiKey", "") or "")
    base_url = str(payload.get("baseUrl", "") or "")
    model = str(payload.get("model", "") or "")

    if provider == "ollama":
        from nanobot.providers.custom_provider import CustomProvider

        return CustomProvider(
            api_key=api_key or "ollama",
            api_base=base_url or "http://localhost:11434/v1",
            default_model=model or "llama3",
        )

    # Primary path: LiteLLM provider with explicit provider_name.
    from nanobot.providers.litellm_provider import LiteLLMProvider

    return LiteLLMProvider(
        api_key=api_key or None,
        api_base=base_url or None,
        default_model=model or None,
        provider_name=provider or None,
    )


async def run_bridge(payload: dict[str, Any]) -> int:
    ensure_python_version()

    nanobot_root = str(payload.get("nanobotRoot", "") or "").strip()
    if not nanobot_root:
        return fail("Missing nanobotRoot in payload.")
    root = Path(nanobot_root).expanduser().resolve()
    if not root.exists():
        return fail(f"Nanobot root does not exist: {root}")

    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    try:
        from nanobot.agent.loop import AgentLoop
        from nanobot.agent.tools.message import MessageTool
        from nanobot.bus.queue import MessageBus
        from nanobot.config.schema import ExecToolConfig
    except Exception as exc:
        return fail(f"Failed to import Nanobot runtime modules: {exc}")

    workspace_root = str(payload.get("workspaceRoot", "") or "").strip()
    if not workspace_root:
        workspace_root = str(Path.cwd())
    workspace = Path(workspace_root).expanduser().resolve()
    workspace.mkdir(parents=True, exist_ok=True)

    content = str(payload.get("content", "") or "").strip()
    if not content:
        return fail("Empty objective/content payload.")

    max_tool_iterations = int(payload.get("maxToolIterations", 40) or 40)
    max_tool_iterations = min(max(max_tool_iterations, 1), 400)
    session_key = str(payload.get("sessionKey", "geepus:direct") or "geepus:direct")
    channel = str(payload.get("channel", "cli") or "cli")
    chat_id = str(payload.get("chatId", "direct") or "direct")
    brave_search_api_key = str(payload.get("braveSearchApiKey", "") or "")

    provider = build_provider(payload)
    bus = MessageBus()
    agent = AgentLoop(
        bus=bus,
        provider=provider,
        workspace=workspace,
        model=str(payload.get("model", "") or provider.get_default_model()),
        max_iterations=max_tool_iterations,
        temperature=0.1,
        max_tokens=8192,
        memory_window=100,
        brave_api_key=brave_search_api_key or None,
        exec_config=ExecToolConfig(timeout=90),
        restrict_to_workspace=False,
    )

    original_execute = agent.tools.execute
    current_phase = "planning"
    milestone_history: list[str] = ["planning"]

    def emit_milestone(phase: str, summary: str, *, detail: str = "") -> None:
        nonlocal current_phase
        phase = str(phase or "").strip().lower()
        if not phase or phase == current_phase:
            return
        current_phase = phase
        milestone_history.append(phase)
        emit(
            "milestone",
            phase=phase,
            summary=str(summary or ""),
            detail=str(detail or "")[:1200],
        )

    emit(
        "milestone",
        phase="planning",
        summary="Nanobot is planning the objective.",
    )

    async def instrumented_execute(self, name: str, params: dict[str, Any]) -> str:
        tool_name = str(name or "").strip().lower()
        if tool_name == "exec":
            next_phase, command_text = classify_exec_command(params)
            emit_milestone(
                next_phase,
                "Nanobot is running verification commands." if next_phase == "verifying" else "Nanobot is executing changes.",
                detail=command_text,
            )
        elif tool_name in {"edit_file", "write_file", "append_file"}:
            emit_milestone("executing", "Nanobot is editing workspace files.")
        elif tool_name in {"web_fetch", "web_search", "read_file", "list_dir"} and current_phase != "executing":
            emit_milestone("planning", "Nanobot is gathering context.")
        emit(
            "tool_call",
            tool=str(name or ""),
            arguments=safe_json_text(params, limit=3000),
        )
        result = await original_execute(name, params)
        if tool_name == "exec":
            next_phase, command_text = classify_exec_command(params)
            if next_phase == "verifying":
                output_text = safe_json_text(result, limit=2500)
                looks_failed = isinstance(result, str) and result.startswith("Error")
                emit(
                    "verification_signal",
                    stage="verification_command",
                    ok=not looks_failed,
                    summary="Nanobot completed a verification command." if not looks_failed else "Nanobot verification command failed.",
                    detail=command_text[:1200],
                    output=output_text,
                )
        emit(
            "tool_result",
            tool=str(name or ""),
            ok=not (isinstance(result, str) and result.startswith("Error")),
            output=safe_json_text(result, limit=5000),
        )
        return result

    agent.tools.execute = MethodType(instrumented_execute, agent.tools)

    async def on_progress(message: str, *, tool_hint: bool = False) -> None:
        if next_phase := detect_phase_from_progress(message, current_phase):
            if next_phase == "verifying":
                emit_milestone("verifying", "Nanobot is verifying the work.")
            elif next_phase == "acceptance":
                emit_milestone("acceptance", "Nanobot is preparing final acceptance output.")
            elif next_phase == "executing":
                emit_milestone("executing", "Nanobot is executing the plan.")
        emit(
            "progress",
            content=str(message or ""),
            toolHint=bool(tool_hint),
        )

    # Avoid relaying message tool output back into Geepus transport directly.
    if message_tool := agent.tools.get("message"):
        if isinstance(message_tool, MessageTool):
            message_tool.start_turn()

    response = ""
    tools_used: list[str] = []
    all_msgs: list[dict[str, Any]] = []
    try:
        agent._set_tool_context(channel, chat_id, None)
        initial_messages = agent.context.build_messages(
            history=[],
            current_message=content,
            media=None,
            channel=channel,
            chat_id=chat_id,
        )
        response, tools_used, all_msgs = await agent._run_agent_loop(
            initial_messages,
            on_progress=on_progress,
        )
    finally:
        try:
            await agent.close_mcp()
        except Exception:
            pass

    emit(
        "result",
        content=str(response or ""),
        toolsUsed=tools_used,
        messages=compact_messages(all_msgs),
        milestones=milestone_history[-20:],
    )
    return 0


def main() -> int:
    try:
        payload = load_payload()
    except Exception as exc:
        return fail(str(exc))

    try:
        return asyncio.run(run_bridge(payload))
    except Exception as exc:
        trace = traceback.format_exc(limit=8)
        message = f"{exc}\n{trace}"
        return fail(message)


if __name__ == "__main__":
    raise SystemExit(main())
