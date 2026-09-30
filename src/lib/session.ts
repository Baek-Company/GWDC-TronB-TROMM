import { z } from 'zod';
import { agentRequestStateSchema } from '../../shared/agent-request';
import { datedAllocationSchema, executionRecordSchema, flowCoverageSchema, observationSchema, planSchema,
  positionFlowSchema, instantSchema } from '../../shared/schemas';

const profileSchema = z.object({
  holdings: z.string(), horizonDays: z.string(), expense: z.string(), expenseDay: z.string(),
  reserve: z.string(), risk: z.enum(['conservative', 'balanced', 'growth']),
  acceptsUsddRisk: z.boolean(),
  acceptsDatedExpenseLiquidityRisk: z.boolean().default(false),
  extraExpenses: z.array(z.object({ id: z.string(), amount: z.string(), day: z.string() })),
});
export type Profile = z.infer<typeof profileSchema>;

export const initialProfile: Profile = {
  holdings: '1000', horizonDays: '30', expense: '200', expenseDay: '7', reserve: '0',
  risk: 'balanced', acceptsUsddRisk: false, acceptsDatedExpenseLiquidityRisk: false, extraExpenses: [],
};

const legacySessionSchema = z.object({
  schemaVersion: z.literal(1),
  profile: profileSchema,
  inputVersion: z.number().int().positive(),
  confirmedVersion: z.number().int().positive().nullable(),
  selectedPlan: planSchema.nullable(),
  records: z.array(executionRecordSchema),
  observations: z.array(observationSchema),
});
const monitoredAgentSchema = z.object({
  plan: planSchema,
  request: agentRequestStateSchema,
  assessmentId: z.string().min(1),
  selectedAt: instantSchema,
  walletAddress: z.string().min(1).nullable(),
  needsReconfirmation: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if ((value.needsReconfirmation !== true && (value.request.confirmedVersion !== value.request.version
    || value.plan.needsVersion !== value.request.version))
    || value.plan.chain !== value.request.explicitFacts.chain
    || value.plan.inputToken.symbol !== value.request.explicitFacts.asset) {
    ctx.addIssue({ code: 'custom', message: '감시 계획과 확인된 요청의 버전·체인·자산이 일치해야 합니다.' });
  }
});
const monitoredAllocationSchema = z.object({
  allocation: datedAllocationSchema,
  // A null request identifies a manual, synthetic comparison saved from /plans.
  request: agentRequestStateSchema.nullable(),
  assessmentId: z.string().min(1).nullable(),
  selectedAt: instantSchema,
  walletAddress: z.string().min(1).nullable(),
  needsReconfirmation: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.request === null) {
    if (value.assessmentId !== null || value.walletAddress !== null
      || value.allocation.chain !== 'mainnet' || value.allocation.asset.symbol !== 'USDT') {
      ctx.addIssue({ code: 'custom', message: '수동 시연 배분안에는 에이전트 평가·지갑 근거가 없어야 합니다.' });
    }
    return;
  }
  if ((value.needsReconfirmation !== true && value.request.confirmedVersion !== value.request.version)
    || value.assessmentId === null
    || (value.needsReconfirmation !== true && value.allocation.inputVersion !== value.request.version)
    || value.allocation.chain !== value.request.explicitFacts.chain
    || value.allocation.asset.symbol !== value.request.explicitFacts.asset) {
    ctx.addIssue({ code: 'custom', message: '날짜별 감시안과 확인된 요청의 버전·체인·자산이 일치해야 합니다.' });
  }
});
const sessionSchema = legacySessionSchema.extend({
  schemaVersion: z.literal(3),
  openingObservations: z.array(z.object({ recordId: z.string().min(1), observation: observationSchema })),
  positionFlows: z.array(positionFlowSchema),
  flowCoverages: z.array(z.object({
    planId: z.string().min(1), positionId: z.string().min(1), walletAddress: z.string().min(1),
    coverage: flowCoverageSchema,
  })),
  // Agent review is intentionally separate from selectedPlan, which is also used by the Nile transaction UI.
  monitoredAgent: monitoredAgentSchema.nullable().default(null),
  monitoredAllocation: monitoredAllocationSchema.nullable().default(null),
  latestAgentRequest: agentRequestStateSchema.nullable().default(null),
});
export type Session = z.infer<typeof sessionSchema>;

export const SESSION_KEY = 'gwdc-lee-mir-session-v3';
export const PREVIOUS_SESSION_KEY = 'gwdc-lee-mir-session-v2';
export const LEGACY_SESSION_KEY = 'gwdc-lee-mir-session-v1';
export type SessionLoadResult =
  | { status: 'absent' | 'valid'; session: Session }
  | { status: 'invalid'; session: Session; raw: string | null };
export function initialSession(): Session {
  return { schemaVersion: 3, profile: { ...initialProfile, extraExpenses: [] }, inputVersion: 1,
    confirmedVersion: null, selectedPlan: null, records: [], observations: [],
    openingObservations: [], positionFlows: [], flowCoverages: [],
    monitoredAgent: null, monitoredAllocation: null, latestAgentRequest: null };
}
export function parseSession(raw: string): Session {
  const value: unknown = JSON.parse(raw);
  if (typeof value === 'object' && value !== null && 'schemaVersion' in value
    && value.schemaVersion === 1) {
    const legacy = legacySessionSchema.parse(value);
    return sessionSchema.parse({ ...legacy, schemaVersion: 3,
      openingObservations: [], positionFlows: [], flowCoverages: [] });
  }
  if (typeof value === 'object' && value !== null && 'schemaVersion' in value
    && value.schemaVersion === 2) {
    const old = value as Record<string, unknown>;
    const staleMonitor = (monitor: unknown): unknown => {
      if (monitor === null || typeof monitor !== 'object') return monitor;
      const entry = monitor as Record<string, unknown>;
      return { ...entry, needsReconfirmation: entry.request !== null,
        request: entry.request === null ? null : agentRequestStateSchema.parse(entry.request) };
    };
    return sessionSchema.parse({ ...old, schemaVersion: 3,
      monitoredAgent: staleMonitor(old.monitoredAgent ?? null),
      monitoredAllocation: staleMonitor(old.monitoredAllocation ?? null),
      latestAgentRequest: old.latestAgentRequest === null || old.latestAgentRequest === undefined
        ? null : agentRequestStateSchema.parse(old.latestAgentRequest) });
  }
  return sessionSchema.parse(value);
}
export function loadSession(): SessionLoadResult {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SESSION_KEY);
    if (raw === null) raw = localStorage.getItem(PREVIOUS_SESSION_KEY);
    if (raw === null) raw = localStorage.getItem(LEGACY_SESSION_KEY);
    return raw === null
      ? { status: 'absent', session: initialSession() }
      : { status: 'valid', session: parseSession(raw) };
  } catch { return { status: 'invalid', session: initialSession(), raw }; }
}
export function saveSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessionSchema.parse(session)));
}
export function backupInvalidSession(raw: string | null): void {
  if (raw === null) return;
  localStorage.setItem(`gwdc-lee-mir-session-backup-${Date.now()}-${crypto.randomUUID()}`, raw);
}
function downloadJson(content: string, filename: string): void {
  const data = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function exportSession(session: Session): void {
  downloadJson(JSON.stringify(sessionSchema.parse(session), null, 2),
    `gwdc-plan-${new Date().toISOString().slice(0, 10)}.json`);
}
export function exportInvalidSession(raw: string): void {
  downloadJson(raw, `gwdc-unreadable-session-${new Date().toISOString().slice(0, 10)}.json`);
}
