import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Per-level thinking budgets for local llama-server (OpenAI-compatible API).
 *
 * Uses the same technique as the llama.cpp web chat:
 *
 *   - `thinking_budget_tokens` (top-level): hard limit for thinking tokens.
 *     The server's "reasoning-budget" sampler counts tokens after the
 *     `think` tag and, when the budget is exhausted, FORCES the end-of-thinking
 *     token (logits of all other tokens -> -inf).
 *   - `reasoning_control: true`: arms the budget sampler.
 *
 * llama-server IGNORES `thinking_token_budget` (the vLLM parameter that omp
 * sends natively), so this extension removes it from the payload and
 * replaces it with the parameters above.
 *
 * Per-level budgets (hard GPU limit):
 *   minimal: 512 | low: 512 | medium: 2048 | high: 8196 | xhigh: 16392 | max: unlimited
 *
 * Only intervenes when the payload contains `chat_template_kwargs` — omp only
 * sends that for models with a `thinkingFormat` of `qwen-chat-template` /
 * `chat-template`, i.e. the llama-server providers. OpenAI, Anthropic, Google
 * and other providers pass through untouched.
 */
const BUDGETS: Record<string, number> = {
  minimal: 512,
  low: 512,
  medium: 2048,
  high: 8196,
  xhigh: 16392,
  // max: intentionally absent -> unlimited
};

export default function thinkingBudgets(pi: ExtensionAPI) {
  pi.setLabel("Thinking Budgets (llama.cpp)");

  pi.on("before_provider_request", (event) => {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") return undefined;

    const p = payload as Record<string, unknown>;

    // Only intervene on llama.cpp-style requests: omp only sends
    // chat_template_kwargs for models with thinkingFormat
    // qwen-chat-template/chat-template (the llama-server providers).
    if (
      typeof p.chat_template_kwargs !== "object" ||
      p.chat_template_kwargs === null
    ) {
      return undefined;
    }

    const level = pi.getThinkingLevel(); // "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"
    const budget = level ? BUDGETS[level] : undefined;

    const {
      thinking_token_budget: _vllm, // ignored by llama-server
      thinking_budget_tokens: _prev,
      reasoning_control: _rc,
      ...rest
    } = p;

    if (budget === undefined) {
      // max / off / unknown level: no thinking budget
      return rest;
    }

    return {
      ...rest,
      thinking_budget_tokens: budget,
      reasoning_control: true,
    };
  });
}
