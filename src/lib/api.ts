import type { ChatMessage, ChatResponse, MissingField, Observation, PlanningResult, TxStatusResponse, UserNeeds } from "../../shared/schemas";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((j as any).error ?? `HTTP ${r.status}`) as Error & { detail?: unknown };
    err.detail = j;
    throw err;
  }
  return j as T;
}

export interface Health {
  ok: boolean;
  time: string;
  config: {
    llmProvider: string;
    llmModel?: string;
    nimKeyConfigured: boolean;
    trongridKeyConfigured: boolean;
    dataMode: "live" | "synthetic";
    enableNileExecution: boolean;
    mcp: Record<string, boolean>;
  };
  mcp: { server: string; state: string; transport?: string; version?: string; tools?: { allowed: string[]; missing: string[]; blocked: string[] }; error?: string; note?: string }[];
}

export interface ObserveResponse {
  observation: Observation;
  snapshot: { balanceSun: string; jTokenBalance: string; energyFeeSun: number; bandwidthFeeSun: number; contractVerified: boolean; contractName?: string; contract: string };
  executionEnabled: boolean;
}

export const api = {
  health: () => req<Health>("/api/health"),
  chat: (messages: ChatMessage[], needs: UserNeeds, lastAsked?: MissingField) =>
    req<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify({ messages, needs, lastAsked }) }),
  plans: (needs: UserNeeds, walletAddress?: string) => req<PlanningResult>("/api/plans", { method: "POST", body: JSON.stringify({ needs, walletAddress }) }),
  recheckGoal: (needs: UserNeeds) => req<PlanningResult>("/api/goal/recheck", { method: "POST", body: JSON.stringify({ needs }) }),
  observe: (wallet: string, planId?: string) =>
    req<ObserveResponse>("/api/observe", { method: "POST", body: JSON.stringify({ chain: "nile", wallet, planId, positionId: "jTRX" }) }),
  tx: (txId: string) => req<TxStatusResponse>(`/api/transactions/${txId}?chain=nile`),
};
