# Thinking Budgets for Local Qwen3 27B

Per-level thinking budgets for local models compatible with llama.cpp, plus a custom chat template for Qwen 3.8 27B that enables all budget sizes. Wired into [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) via a small extension.

```
.
├── pi/
│   └── agent/
│       ├── extensions/thinking-budgets.ts   # pi extension: per-level thinking budgets
│       └── models.json                      # pi provider config for the local server
└── Qwen 3.8 27B/
    └── chat_template_budget.jinja           # custom chat template for llama.cpp
```

---

## 1. What the extension is

`pi/agent/extensions/thinking-budgets.ts` is a pi extension that gives a local `llama-server` (OpenAI-compatible API) **hard thinking-token budgets per thinking level**.

### The problem

pi natively sends thinking limits as `thinking_token_budget` — a vLLM parameter. `llama-server` **ignores** that parameter, so on llama.cpp the thinking level had no real enforcement: the model could think as long as it wanted.

### The solution

llama.cpp has its own mechanism (the same one the llama.cpp web chat uses):

- `thinking_budget_tokens` (top-level) — hard limit for thinking tokens. The server's *reasoning-budget* sampler counts tokens emitted after the `think` tag and, when the budget is exhausted, **forces the end-of-thinking token** (logits of all other tokens → −inf).
- `reasoning_control: true` — arms the budget sampler.

The extension hooks pi's `before_provider_request` event and, for llama.cpp-style requests only:

1. Removes `thinking_token_budget` (the vLLM parameter llama-server ignores).
2. Replaces it with `thinking_budget_tokens` + `reasoning_control: true`.
3. Maps pi's thinking level to a budget from the `BUDGETS` map:

   | Level     | Budget (tokens) |
   | --------- | --------------- |
   | `minimal` | 512             |
   | `low`     | 512             |
   | `medium`  | 2048            |
   | `high`    | 8196            |
   | `xhigh`   | 16392           |
   | `max`     | unlimited       |
   | `off`     | no budget sent  |

   To change the values, edit the `BUDGETS` map in the extension.

### Safety

The extension only intervenes when the payload contains `chat_template_kwargs` — pi only sends that for models with a `thinkingFormat` of `qwen-chat-template`/`chat-template`, i.e. the llama-server providers. OpenAI, Anthropic, and other providers pass through untouched.

---

## 2. Setting up in `.pi`

pi discovers extensions and model configs in the agent directory. Either location works:

| Location                | Scope            |
| ----------------------- | ---------------- |
| `~/.pi/agent/`          | Global (all projects) |
| `.pi/` (project root)   | Project-local  |

### Global setup

Copy the files from this repo into `~/.pi/agent/`:

```bash
# Linux / macOS
mkdir -p ~/.pi/agent/extensions
cp "pi/agent/extensions/thinking-budgets.ts" ~/.pi/agent/extensions/
cp "pi/agent/models.json" ~/.pi/agent/

# Windows (PowerShell)
New-Item -ItemType Directory -Force ~/.pi/agent/extensions | Out-Null
Copy-Item "pi/agent/extensions/thinking-budgets.ts" ~/.pi/agent/extensions/
Copy-Item "pi/agent/models.json" ~/.pi/agent/
```

### Project-local setup

Alternatively, keep everything scoped to this project. Move/copy the files into `.pi/` at the project root:

```bash
mkdir -p .pi/extensions
mv "pi/agent/extensions/thinking-budgets.ts" .pi/extensions/
mv "pi/agent/models.json" .pi/
```

pi auto-discovers `.pi/extensions/*.ts` and `.pi/models.json`.

After setup, start pi and run `/reload` (extensions in auto-discovered locations hot-reload). The `LocalVision-8080` and `LocalNoVision-8080` providers appear in `/model`.

> **Note:** the extension file must be reachable by pi's TS loader. If pi complains it can't find `@earendil-works/pi-coding-agent`, run pi from a directory where that package is installed (e.g. globally via npm), or install it in the project: `npm i @earendil-works/pi-coding-agent`.

---

## 3. Setting up the local model

### a. Serve the model with `llama-server`

Use a current llama.cpp build. Start the server on port 8080:

```bash
llama-server \
  -m Qwen3-27B-Q4_K_M.gguf \
  --jinja \
  --chat-template-file "Qwen 3.8 27B/chat_template_budget.jinja" \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 999 \
  -c 32768
```

Key options:

- `--jinja` — enables the (custom) chat template and tool calling.
- `--chat-template-file` — replaces the template embedded in the GGUF with `chat_template_budget.jinja` (see section 4).
- `-ngl 999` — offload all layers to GPU.
- `-c 32768` — context window per loaded model.

For router mode (multiple GGUFs, load/unload on demand) start `llama-server` **without** `-m` and use `--models-dir` instead; then manage models from pi with `/llama`.

### b. Register the provider in pi

`pi/agent/models.json` (copied to `~/.pi/agent/models.json`) defines two providers pointing at the same server:

- **`LocalVision-8080`** — `qwen3-27b` with `input: ["text", "image"]` (needs the `mmproj` vision projector on the server).
- **`LocalNoVision-8080`** — same model, text-only.

Both use:

- `api: "openai-completions"` against `http://localhost:8080/v1`
- `reasoning: true` + `thinkingLevelMap` — pi's thinking levels map 1:1 to the server's levels.
- `compat.supportsDeveloperRole: false` — llama.cpp doesn't know the `developer` role, so pi sends the system prompt as a `system` message.
- `compat.thinkingFormat: "qwen-chat-template"` — tells pi to send `chat_template_kwargs` (this is what triggers the extension).
- `chatTemplateKwargs`:
  - `enable_thinking: { "$var": "thinking.enabled" }` — thinking on/off follows pi's setting.
  - `preserve_thinking: true` — previous `think` blocks are kept in context.

Select the model in pi with `/model` → `LocalVision-8080/qwen3-27b` (or the no-vision variant).

---

## 4. Replacing the chat template in llama.cpp

### Why

The stock Qwen3 template doesn't expose reasoning-effort levels or a budget mechanism. `Qwen 3.8 27B/chat_template_budget.jinja` is a custom Jinja template that:

- Accepts `enable_thinking` (on/off) and `reasoning_effort` (`low` | `medium` | `high` | `xhigh` | `max`, default `low`) as template variables.
- Injects a per-level "reasoning effort" instruction into the system message.
- Handles tool calls in the `<tool_call>…</tool_call>` format, `tool` role messages, images (`image` tokens), and `preserve_thinking` of previous thinking blocks.
- Emits the correct generation prompt (`think` tag open/close) based on `enable_thinking`.

### How to apply it

Pass the file to `llama-server`:

```bash
llama-server \
  -m Qwen3-27B-Q4_K_M.gguf \
  --jinja \
  --chat-template-file "Qwen 3.8 27B/chat_template_budget.jinja" \
  --host 127.0.0.1 \
  --port 8080
```

- `--chat-template-file <path>` — loads the template from a file (recommended; keeps the long template out of the command line).
- `--chat-template '<jinja string>'` — inline alternative; impractical for templates this size.
- Omit both and llama.cpp uses the template embedded in the GGUF (the stock Qwen3 template).

The template variables (`enable_thinking`, `reasoning_effort`, `preserve_thinking`) are supplied by pi through `chat_template_kwargs` in `models.json` — that's the link between pi's thinking levels and the template's behavior. The extension then adds the hard `thinking_budget_tokens` on top.

### Verify

After starting the server, send a quick request:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3-27b", "messages": [{"role": "user", "content": "hi"}], "chat_template_kwargs": {"enable_thinking": true, "reasoning_effort": "low"}}'
```

A working setup returns a response with a `think` block whose length respects the budget set by the extension.
