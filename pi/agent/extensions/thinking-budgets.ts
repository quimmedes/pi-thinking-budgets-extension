import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Per-level thinking budgets for local llama-server (OpenAI-compatible API).
 *
 * Uses the SAME technique as the llama.cpp web chat
 * (tools/ui/src/lib/services/chat.service.ts):
 *
 *   - `thinking_budget_tokens` (top-level): hard limit for thinking tokens.
 *     The server's "reasoning-budget" sampler counts tokens after the
 *     `think` tag and, when the budget is exhausted, FORCES the end-of-thinking
 *     token (logits of all other tokens -> -inf).
 *   - `reasoning_control: true`: arms the budget sampler (identical to the web chat).
 *
 * llama-server IGNORES `thinking_token_budget` (the vLLM parameter that pi
 * sends natively), so this extension removes it from the payload and
 * replaces it with the parameters above.
 *
 * Per-level budgets (hard GPU limit):
 *   low: 512 | medium: 2048 | high: 8196 | xhigh: 16392 | max: unlimited
 *
 * (minimal is treated as low; off sends no budget — pi already disables
 * thinking via enable_thinking=false in the qwen-chat-template format.)
 *
 * To change the values, edit the BUDGETS map below.
 */
const BUDGETS: Record<string, number> = {
  minimal: 512,
  low: 512,
  medium: 2048,
  high: 8196,
  xhigh: 16392,
  // max: intentionally absent -> unlimited
};

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") return undefined;

    const p = payload as Record<string, unknown>;

    // Only intervenes on llama.cpp-style requests: pi only sends
    // chat_template_kwargs for models with thinkingFormat
    // qwen-chat-template/chat-template (the llama-server providers).
    // OpenAI/Anthropic/etc. providers pass through untouched.
    if (typeof p.chat_template_kwargs !== "object" || p.chat_template_kwargs === null) {
      return undefined;
    }

    const level = ctx.thinkingLevel; // "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"
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
