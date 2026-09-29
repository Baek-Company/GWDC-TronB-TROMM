import { env, redact } from "../env";
import { NeedsPatch, type ChatMessage, type UserNeeds } from "../../shared/schemas";
import { compactForExplain, EXPLAIN_SYSTEM_PROMPT, EXTRACT_SYSTEM_PROMPT, LlmError, type LlmProvider } from "./provider";

// NVIDIA NIM (OpenAI 호환 chat/completions). 비스트리밍.

interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function createOpenAiCompatible(opts: { name: string; baseUrl: string; apiKey: string; model: string; timeoutMs: number }): LlmProvider {
  async function complete(messages: OpenAiMessage[], maxTokens: number, timeoutMs = opts.timeoutMs): Promise<{ content: string; latencyMs: number }> {
    if (!opts.apiKey || !opts.model) throw new LlmError(`${opts.name} 키 또는 모델이 설정되지 않았습니다`, "config");
    const body = JSON.stringify({ model: opts.model, messages, max_tokens: maxTokens, temperature: 0 });
    let lastErr: LlmError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now();
      let r: Response;
      try {
        r = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const name = (e as Error).name;
        throw new LlmError(name === "TimeoutError" || name === "AbortError" ? `${opts.name} 응답 시간 초과 (${timeoutMs}ms)` : `${opts.name} 네트워크 오류`, name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
      }
      if (r.status === 401 || r.status === 403) throw new LlmError(`${opts.name} 인증 실패 (HTTP ${r.status})`, "auth");
      if (r.status === 429 || r.status >= 500) {
        lastErr = new LlmError(`${opts.name} 일시 오류 (HTTP ${r.status})`, r.status === 429 ? "rate_limit" : "server");
        await new Promise((res) => setTimeout(res, 1500));
        continue;
      }
      if (!r.ok) throw new LlmError(`${opts.name} 요청 실패 (HTTP ${r.status}): ${redact((await r.text()).slice(0, 200))}`, "server");
      const j: any = await r.json();
      const content = j?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new LlmError(`${opts.name} 빈 응답`, "format");
      return { content, latencyMs: Date.now() - t0 };
    }
    throw lastErr!;
  }

  return {
    name: opts.name,
    model: opts.model,

    async extractNeeds(messages: ChatMessage[], current: UserNeeds, today: string) {
      const convo: OpenAiMessage[] = [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT(today, current) },
        // 최근 대화만 보낸다. 마지막 사용자 문장이 추출 대상이다.
        ...messages.slice(-6).map((m) => ({ role: m.role, content: m.content }) as OpenAiMessage),
      ];
      const first = await complete(convo, 2000);
      let parsed = parsePatch(first.content);
      let latency = first.latencyMs;
      if (!parsed.ok) {
        // 형식 오류는 한 번만 보정 요청한다.
        const repair = await complete(
          [...convo, { role: "assistant", content: first.content.slice(0, 1500) }, { role: "user", content: `형식 오류: ${parsed.error}. 지정한 JSON 객체 하나만 다시 출력해.` }],
          2000,
        );
        latency += repair.latencyMs;
        parsed = parsePatch(repair.content);
        if (!parsed.ok) throw new LlmError(`모델 응답 형식 오류: ${parsed.error}`, "format");
      }
      return { patch: parsed.patch, latencyMs: latency };
    },

    async explainPlans(result) {
      const r = await complete(
        [
          { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(compactForExplain(result)) },
        ],
        2500,
        Math.min(opts.timeoutMs, 10_000),
      );
      return { text: r.content.trim(), latencyMs: r.latencyMs };
    },
  };
}

export function parsePatch(content: string): { ok: true; patch: NeedsPatch } | { ok: false; error: string } {
  const cleaned = content.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "JSON 객체가 없습니다" };
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return { ok: false, error: "JSON 파싱 실패" };
  }
  // 모델이 숫자로 준 금액을 문자열로 정규화
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, any>;
    for (const k of ["amount", "bufferAmount"]) if (typeof o[k] === "number") o[k] = String(o[k]);
    if (Array.isArray(o.expenses)) for (const e of o.expenses) if (e && typeof e.amount === "number") e.amount = String(e.amount);
    for (const k of ["amount", "bufferAmount"]) if (typeof o[k] === "string") o[k] = o[k].replace(/,/g, "");
    if (Array.isArray(o.expenses)) for (const e of o.expenses) if (e && typeof e.amount === "string") e.amount = e.amount.replace(/,/g, "");
  }
  const r = NeedsPatch.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) };
  return { ok: true, patch: r.data };
}

export function createNim(): LlmProvider {
  return createOpenAiCompatible({ name: "NVIDIA NIM", baseUrl: env.nimBaseUrl, apiKey: env.nimApiKey, model: env.nimModel, timeoutMs: env.llmTimeoutMs });
}
