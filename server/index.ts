import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { env, publicConfig, redact } from "./env";
import { createNim } from "./llm/nim";
import { compactForExplain, LlmError, unknownNumbers, type LlmProvider } from "./llm/provider";
import { preserveExplicitHolding, templateExplain, templateExtract } from "./llm/template";
import { getMainnetInputs, getNileInputs } from "./data/quotes";
import { chainFees, contractExists, EXPLORER, isBase58Address, trxBalanceSun, txInfo } from "./data/tron-rpc";
import { JUSTLEND, nileJtrxPosition } from "./data/justlend";
import { connectAll, mcpStatuses } from "./mcp/clients";
import { applyPatch, inputProblems, missingFields, nextQuestion, summarizeNeeds, todaySeoul } from "../shared/needs";
import { FundingError } from "../shared/funding";
import { buildMainnetPlans, buildNilePlans } from "../shared/planning";
import { sunToTrx } from "../shared/units";
import { ChatMessage, UserNeeds, type ChatResponse, type MissingField, type Observation, type PlanningResult, type TxStatusResponse } from "../shared/schemas";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

// 허용한 개발 앱 출처만 받는다. (Vite 프록시 경유 요청은 Origin이 없거나 같은 출처)
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:5173`, `http://localhost:5173`, `http://127.0.0.1:${env.apiPort}`, `http://localhost:${env.apiPort}`]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: "허용되지 않은 출처입니다" });
  next();
});

function provider(): LlmProvider | undefined {
  if (env.llmProvider === "nim" && env.nimApiKey) return createNim();
  // TRON LLM 어댑터(tron.ts)는 공식 명세 수령 후 추가한다. 그 전에는 템플릿을 쓴다.
  return undefined;
}

const fallbackReason = (e: unknown) => (e instanceof LlmError ? `${e.kind}: ${e.message}` : redact(String((e as Error)?.message ?? e)));

// ------------------------------------------------------------------ health
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), config: publicConfig(), mcp: mcpStatuses() });
});

// ------------------------------------------------------------------ chat
const ChatBody = z.object({
  messages: z.array(ChatMessage).min(1).max(40),
  needs: UserNeeds,
  lastAsked: z.enum(["amount", "endDate", "expenses", "bufferAmount", "riskProfile", "acceptUsddRisk"]).optional(),
});

app.post("/api/chat", async (req, res) => {
  const body = ChatBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "요청 형식이 올바르지 않습니다" });
  const { messages, needs, lastAsked } = body.data;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return res.status(400).json({ error: "마지막 메시지는 사용자 입력이어야 합니다" });
  const today = todaySeoul();

  const p = provider();
  let patch;
  const llm: ChatResponse["llm"] = { provider: p?.name ?? "template", model: p?.model, used: false };
  if (p) {
    try {
      const r = await p.extractNeeds(messages, needs, today);
      patch = r.patch;
      llm.used = true;
      llm.latencyMs = r.latencyMs;
    } catch (e) {
      llm.fallbackReason = fallbackReason(e);
      console.warn("[chat] LLM 추출 실패 → 템플릿:", llm.fallbackReason);
    }
  } else {
    llm.fallbackReason = env.llmProvider === "tron" ? "TRON LLM 어댑터는 공식 명세 수령 대기 중" : "LLM 키 미설정";
  }
  if (!patch) patch = templateExtract(last.content, lastAsked, today, needs);
  else patch = preserveExplicitHolding(patch, last.content, lastAsked, today, needs);

  const { needs: next, changed } = applyPatch(needs, patch);
  const missing = missingFields(next);
  const problems = inputProblems(next);

  const parts: string[] = [];
  if (changed.length) parts.push("이렇게 이해했어요.\n" + summarizeNeeds(next).map((l) => `• ${l}`).join("\n"));
  else parts.push("새로 반영할 정보를 찾지 못했어요.");
  if (problems.length) parts.push(problems.map((x) => `⚠ ${x}`).join("\n"));
  const q = nextQuestion(missing);
  if (q) parts.push(q);
  else if (!problems.length) parts.push("필요한 정보가 모두 모였어요. 아래 요약을 확인하고 '이대로 확인'을 눌러 주세요. 확인 전에는 계획을 확정하지 않습니다.");

  const out: ChatResponse = {
    needs: next,
    missing,
    problems,
    reply: parts.join("\n\n"),
    state: missing.length || problems.length ? "collecting" : "awaiting_confirmation",
    llm,
  };
  res.json(out);
});

// ------------------------------------------------------------------ plans
const PlansBody = z.object({ needs: UserNeeds, walletAddress: z.string().optional() });

app.post("/api/plans", async (req, res) => {
  const body = PlansBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "요구사항 형식이 올바르지 않습니다" });
  const { needs, walletAddress } = body.data;
  const missing: MissingField[] = missingFields(needs);
  const problems = inputProblems(needs);
  if (missing.length || problems.length) return res.status(422).json({ error: "확인되지 않은 입력이 있습니다", missing, problems });

  let base: Omit<PlanningResult, "explanation">;
  if (needs.chain === "mainnet") {
    const f = await getMainnetInputs();
    try {
      base = buildMainnetPlans(needs, f.inputs);
    } catch (error) {
      if (error instanceof FundingError) return res.status(422).json({ error: error.message });
      throw error;
    }
    base.warnings.unshift(...f.failures);
  } else {
    const f = await getNileInputs();
    let walletBalanceTrx: string | undefined;
    if (walletAddress) {
      if (!isBase58Address(walletAddress)) return res.status(400).json({ error: "지갑 주소 형식이 올바르지 않습니다" });
      try {
        walletBalanceTrx = sunToTrx(await trxBalanceSun("nile", walletAddress));
      } catch (e) {
        f.failures.push(`Nile 지갑 잔고 조회 실패: ${(e as Error).message}`);
      }
    }
    base = buildNilePlans(needs, { ...f.inputs, walletBalanceTrx });
    base.warnings.unshift(...f.failures);
  }

  let explanation: PlanningResult["explanation"];
  const p = provider();
  if (p) {
    try {
      const r = await p.explainPlans(base);
      const bad = unknownNumbers(r.text, compactForExplain(base));
      explanation = bad.length
        ? { text: templateExplain(base), source: "template", fallbackReason: `AI 설명에 계산 결과에 없는 숫자(${bad.slice(0, 3).join(", ")})가 있어 폐기했습니다` }
        : { text: r.text, source: "llm", provider: p.name, model: p.model };
    } catch (e) {
      explanation = { text: templateExplain(base), source: "template", fallbackReason: fallbackReason(e) };
    }
  } else {
    explanation = { text: templateExplain(base), source: "template", fallbackReason: "LLM 키 미설정" };
  }
  res.json({ ...base, explanation } satisfies PlanningResult);
});

// 목표 감시 재평가: 현재 데이터 모드로 다시 계산하되 모델 호출·거래 생성은 하지 않는다.
app.post("/api/goal/recheck", async (req, res) => {
  const body = z.object({ needs: UserNeeds }).safeParse(req.body);
  if (!body.success || body.data.needs.chain !== "mainnet") return res.status(400).json({ error: "Mainnet 목표 형식이 올바르지 않습니다" });
  const needs = body.data.needs;
  const missing = missingFields(needs);
  const problems = inputProblems(needs);
  if (missing.length || problems.length) return res.status(422).json({ error: "요구사항을 다시 확인해야 합니다", missing, problems });
  const fetched = await getMainnetInputs();
  const asOf = todaySeoul();
  const remainingNeeds = { ...needs, startDate: needs.startDate > asOf ? needs.startDate : asOf };
  let result: Omit<PlanningResult, "explanation">;
  try {
    result = buildMainnetPlans(remainingNeeds, fetched.inputs);
  } catch (error) {
    if (error instanceof FundingError) return res.status(422).json({ error: error.message });
    throw error;
  }
  result.warnings.unshift(...fetched.failures);
  res.json({ ...result, explanation: { text: templateExplain(result), source: "template" } } satisfies PlanningResult);
});

// ------------------------------------------------------------------ observe
const ObserveBody = z.object({ chain: z.literal("nile"), wallet: z.string(), planId: z.string().optional(), positionId: z.literal("jTRX") });

app.post("/api/observe", async (req, res) => {
  const body = ObserveBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "요청 형식이 올바르지 않습니다 (Nile jTRX 포지션만 지원)" });
  const { wallet, planId } = body.data;
  if (!isBase58Address(wallet)) return res.status(400).json({ error: "지갑 주소 형식이 올바르지 않습니다" });
  try {
    const [balanceSun, pos, fees, code] = await Promise.all([
      trxBalanceSun("nile", wallet),
      nileJtrxPosition(wallet),
      chainFees("nile"),
      contractExists("nile", JUSTLEND.nile.jTRX),
    ]);
    const observedAt = new Date().toISOString();
    const observation: Observation = {
      id: `obs-${Date.now()}`,
      planId: planId ?? "",
      positionId: `nile:jTRX:${wallet}`,
      chain: "nile",
      wallet,
      observedAt,
      balances: [
        { asset: "TRX", amount: sunToTrx(balanceSun) },
        { asset: "jTRX", amount: pos.jToken },
      ],
      underlyingValue: pos.underlyingTrx,
      valuationBasis: "jTRX 잔고 × exchangeRateStored (기초자산 TRX)",
      source: { sourceUrl: `https://nile.tronscan.org/#/address/${wallet}`, chain: "nile", fetchedAt: observedAt, mode: "live", accessMethod: "direct" },
    };
    res.json({
      observation,
      snapshot: {
        balanceSun: balanceSun.toString(),
        jTokenBalance: pos.jTokenRaw.toString(),
        energyFeeSun: fees.energyFeeSun,
        bandwidthFeeSun: fees.bandwidthFeeSun,
        contractVerified: code.exists && code.name === "JustLend-TRX",
        contractName: code.name,
        contract: JUSTLEND.nile.jTRX,
      },
      executionEnabled: env.enableNileExecution,
    });
  } catch (e) {
    res.status(502).json({ error: `Nile 조회 실패: ${redact((e as Error).message)}` });
  }
});

// ------------------------------------------------------------------ transactions
app.get("/api/transactions/:txId", async (req, res) => {
  const txId = String(req.params.txId);
  if (req.query.chain !== "nile") return res.status(400).json({ error: "chain=nile만 지원합니다" });
  if (!/^[0-9a-f]{64}$/i.test(txId)) return res.status(400).json({ error: "txID 형식이 올바르지 않습니다" });
  try {
    const { solid, latest } = await txInfo("nile", txId);
    const src = { sourceUrl: EXPLORER.nile + txId, chain: "nile" as const, fetchedAt: new Date().toISOString(), mode: "live" as const, accessMethod: "direct" as const };
    let out: TxStatusResponse;
    if (solid?.id) {
      const result = solid.receipt?.result;
      out = {
        txId,
        chain: "nile",
        status: result && result !== "SUCCESS" ? "failed" : "confirmed",
        blockNumber: solid.blockNumber,
        feeTrx: sunToTrx(BigInt(solid.fee ?? 0)),
        energyUsed: solid.receipt?.energy_usage_total,
        result: result ?? "SUCCESS",
        source: { ...src, note: "확정(solidity) 노드 영수증" },
      };
    } else if (latest?.id) {
      out = { txId, chain: "nile", status: "pending", blockNumber: latest.blockNumber, result: latest.receipt?.result, source: { ...src, note: "블록 포함, 확정 대기" } };
    } else {
      out = { txId, chain: "nile", status: "not_found", source: src };
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: `영수증 조회 실패: ${redact((e as Error).message)}` });
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[api]", redact(String((err as Error)?.stack ?? err)));
  res.status(500).json({ error: "서버 오류" });
});

app.listen(env.apiPort, "127.0.0.1", () => {
  const c = publicConfig();
  console.log(`[api] http://127.0.0.1:${env.apiPort}  LLM=${c.llmProvider}(${c.nimKeyConfigured ? "키 있음" : "키 없음"}) DATA_MODE=${c.dataMode} NILE_EXEC=${c.enableNileExecution}`);
  connectAll().then((s) => console.log("[mcp]", s.map((x) => `${x.server}:${x.state}`).join(" ")));
});
