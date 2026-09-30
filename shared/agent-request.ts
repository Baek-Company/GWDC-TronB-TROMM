import Decimal from 'decimal.js';
import { z } from 'zod';
import { chainSchema, dateSchema, instantSchema, userNeedsSchema, type Token, type UserNeeds } from './schemas';

// Preserve stated values even when precision or positivity is invalid, so the validator
// can ask for a corrected field instead of discarding or silently rounding the value.
const amountSchema = z.string().regex(/^\d+(?:\.\d+)?$/);
const assetSchema = z.enum(['USDT', 'USDD', 'TRX']);
const dueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('date'), date: dateSchema }).strict(),
  z.object({ type: z.literal('relative_days'), days: z.number().int().min(0).max(3650) }).strict(),
]);
export type DeclaredDate = z.infer<typeof dueSchema>;

export const declaredExpenseSchema = z.object({
  due: dueSchema.nullable(), amount: amountSchema.nullable(), asset: assetSchema.nullable(),
}).strict();
export type DeclaredExpense = z.infer<typeof declaredExpenseSchema>;

export const explicitFactsSchema = z.object({
  chain: chainSchema.nullable(), asset: assetSchema.nullable(), statedHoldings: amountSchema.nullable(),
  startDate: dueSchema.nullable(), horizonDays: z.number().int().min(1).max(3650).nullable(),
  expenseDeclaration: z.enum(['unknown', 'none', 'scheduled']),
  expenses: z.array(declaredExpenseSchema).max(100), reserve: amountSchema.nullable(),
  risk: z.enum(['conservative', 'balanced', 'growth']).nullable(), acceptsUsddRisk: z.boolean().nullable(),
  acceptsDatedExpenseLiquidityRisk: z.boolean().nullable(),
}).strict().superRefine((facts, ctx) => {
  if (facts.expenseDeclaration === 'none' && facts.expenses.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['expenses'], message: '지출 없음과 지출 목록이 동시에 존재할 수 없습니다.' });
  }
  if (facts.expenseDeclaration === 'unknown' && facts.expenses.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['expenseDeclaration'], message: '지출 목록이 있으면 지출 예정으로 표시해야 합니다.' });
  }
});
export type ExplicitFacts = z.infer<typeof explicitFactsSchema>;

const evidenceSchema = z.object({
  path: z.string().min(1), messageId: z.string().min(1).max(100), excerpt: z.string().min(1).max(500),
  utteredAt: instantSchema,
}).strict();
export type FactEvidence = z.infer<typeof evidenceSchema>;
const conflictSchema = z.object({
  path: z.string().min(1), previous: z.string(), proposed: z.string(), messageId: z.string().min(1),
}).strict();
export type RequestConflict = z.infer<typeof conflictSchema>;

const agentRequestV2Schema = z.object({
  schemaVersion: z.literal(2), version: z.number().int().positive(),
  intent: z.enum(['unknown', 'research_only', 'plan_only', 'plan_and_research']),
  explicitFacts: explicitFactsSchema,
  marketQuestions: z.array(z.string().min(1).max(2000)).max(30),
  evidence: z.array(evidenceSchema).max(150), conflicts: z.array(conflictSchema).max(30),
  confirmedVersion: z.number().int().positive().nullable(),
  questionState: z.object({ field: z.string().nullable(), id: z.string().nullable(), failedAttempts: z.number().int().min(0) }).strict(),
}).strict().superRefine((request, ctx) => {
  if (request.confirmedVersion !== null && request.confirmedVersion > request.version) {
    ctx.addIssue({ code: 'custom', path: ['confirmedVersion'], message: '확인 버전이 입력 버전보다 큽니다.' });
  }
});
// A v1 confirmation did not cover the liquidity risk of investing scheduled expenses.
// Migrate once on parse and require a fresh confirmation; never infer consent.
export const agentRequestStateSchema = z.preprocess(raw => {
  if (typeof raw !== 'object' || raw === null || !('schemaVersion' in raw) || raw.schemaVersion !== 1) return raw;
  if (!('explicitFacts' in raw) || typeof raw.explicitFacts !== 'object' || raw.explicitFacts === null) return raw;
  const old = raw as Record<string, unknown> & { explicitFacts: Record<string, unknown> };
  return { ...old, schemaVersion: 2,
    version: typeof old.version === 'number' ? old.version + 1 : old.version,
    confirmedVersion: null,
    questionState: { field: null, id: null, failedAttempts: 0 },
    explicitFacts: { ...old.explicitFacts, acceptsDatedExpenseLiquidityRisk: null } };
}, agentRequestV2Schema);
export type AgentRequestState = z.infer<typeof agentRequestStateSchema>;

export type RequestValidation = {
  status: 'unknown' | 'research_only' | 'incomplete' | 'ready_for_confirmation' | 'confirmed';
  missingFields: string[];
  invalidFields: string[];
  conflicts: RequestConflict[];
  candidateInputs: Record<'hold' | 'justlend_jusdt' | 'psm_jusdd' | 'justlend_jtrx', {
    ready: boolean; missingFields: string[]; excludedReason: string | null;
  }>;
};

export type AgentIntakeQuestion = { id: string; field: string; text: string; mode: 'chat' | 'form'; ask: boolean };
export type AgentIntakeResult = {
  request: AgentRequestState;
  validation: RequestValidation;
  nextQuestion: AgentIntakeQuestion | null;
  progress: 'advanced' | 'unrecognized' | 'research';
  changed: boolean;
};

export function emptyAgentRequest(): AgentRequestState {
  return {
    schemaVersion: 2, version: 1, intent: 'unknown',
    explicitFacts: {
      chain: null, asset: null, statedHoldings: null, startDate: null, horizonDays: null,
      expenseDeclaration: 'unknown', expenses: [], reserve: null, risk: null, acceptsUsddRisk: null,
      acceptsDatedExpenseLiquidityRisk: null,
    },
    marketQuestions: [], evidence: [], conflicts: [], confirmedVersion: null,
    questionState: { field: null, id: null, failedAttempts: 0 },
  };
}

function seoulDateAt(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (name: string) => parts.find(value => value.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function resolveDeclaredDate(date: DeclaredDate, evidence: FactEvidence | undefined): string | null {
  if (date.type === 'date') return date.date;
  return evidence ? addDays(seoulDateAt(evidence.utteredAt), date.days) : null;
}

function fieldDate(request: AgentRequestState, date: DeclaredDate | null, path: string): string | null {
  return date === null ? null : resolveDeclaredDate(date, request.evidence.find(item => item.path === path));
}

export function validateAgentRequest(raw: unknown): RequestValidation {
  const request = agentRequestStateSchema.parse(raw);
  const f = request.explicitFacts;
  const emptyCandidate = (reason: string | null = null) => ({ ready: false, missingFields: [] as string[], excludedReason: reason });
  const candidates: RequestValidation['candidateInputs'] = {
    hold: emptyCandidate(), justlend_jusdt: emptyCandidate(), psm_jusdd: emptyCandidate(), justlend_jtrx: emptyCandidate(),
  };
  if (request.intent === 'unknown' || request.intent === 'research_only') {
    return { status: request.intent, missingFields: [], invalidFields: [], conflicts: request.conflicts, candidateInputs: candidates };
  }
  const missingFields: string[] = [];
  const invalidFields: string[] = [];
  for (const key of ['chain', 'asset', 'statedHoldings', 'startDate', 'horizonDays', 'reserve', 'risk'] as const) {
    if (f[key] === null) missingFields.push(key);
  }
  // The current assessment runner supports only these same-chain input pairs.
  // Keep the user's stated pair intact and ask for one editable field to change.
  if (f.asset === 'USDD') invalidFields.push('asset');
  else if (f.chain !== null && f.asset === 'USDT' && f.chain !== 'mainnet') invalidFields.push('chain');
  else if (f.chain !== null && f.asset === 'TRX' && f.chain !== 'nile') invalidFields.push('chain');
  if (f.expenseDeclaration === 'unknown') missingFields.push('expenseDeclaration');
  if (f.expenseDeclaration === 'scheduled') {
    if (f.expenses.length === 0) missingFields.push('expenses[0]');
    f.expenses.forEach((expense, index) => {
      if (expense.due === null) missingFields.push(`expenses[${index}].due`);
      if (expense.amount === null) missingFields.push(`expenses[${index}].amount`);
      if (expense.asset === null) missingFields.push(`expenses[${index}].asset`);
      if (f.asset !== null && expense.asset !== null && expense.asset !== f.asset) invalidFields.push(`expenses[${index}].asset`);
      if (expense.due && fieldDate(request, expense.due, `explicitFacts.expenses[${index}].due`) === null) {
        invalidFields.push(`expenses[${index}].due`);
      }
    });
  }
  const startDate = fieldDate(request, f.startDate, 'explicitFacts.startDate');
  if (f.startDate !== null && startDate === null) invalidFields.push('startDate');
  if (startDate !== null) {
    f.expenses.forEach((expense, index) => {
      const due = expense.due && fieldDate(request, expense.due, `explicitFacts.expenses[${index}].due`);
      if (due !== null && due !== undefined && due < startDate) invalidFields.push(`expenses[${index}].due`);
    });
  }
  if (f.reserve !== null && f.statedHoldings !== null && new Decimal(f.reserve).gt(f.statedHoldings)) {
    invalidFields.push('reserve');
  }
  if (f.statedHoldings !== null && !new Decimal(f.statedHoldings).gt(0)) invalidFields.push('statedHoldings');
  const decimals = f.asset === 'USDD' ? 18 : 6;
  const tooPrecise = (value: string | null) => value !== null && ((value.split('.')[1]?.length ?? 0) > decimals || value.split('.')[0].length > 78);
  if (f.asset !== null && tooPrecise(f.statedHoldings)) invalidFields.push('statedHoldings');
  if (f.asset !== null && tooPrecise(f.reserve)) invalidFields.push('reserve');
  if (f.expenseDeclaration === 'scheduled') f.expenses.forEach((expense, index) => {
    const asset = expense.asset;
    if (expense.amount !== null && (!new Decimal(expense.amount).gt(0)
      || expense.amount.split('.')[0].length > 78
      || (asset !== null && (expense.amount.split('.')[1]?.length ?? 0) > (asset === 'USDD' ? 18 : 6)))) {
      invalidFields.push(`expenses[${index}].amount`);
    }
  });
  if (f.statedHoldings !== null && f.reserve !== null && f.expenseDeclaration === 'scheduled'
    && f.expenses.every(expense => expense.amount !== null && expense.asset === f.asset)) {
    const promised = f.expenses.reduce((sum, expense) => sum.plus(expense.amount!), new Decimal(f.reserve));
    if (promised.gt(f.statedHoldings)) invalidFields.push('fundingCoverage');
  }
  const coreReady = missingFields.length === 0 && invalidFields.length === 0 && request.conflicts.length === 0;
  candidates.hold = { ready: coreReady, missingFields: [...missingFields, ...invalidFields], excludedReason: null };
  const forCandidate = (asset: 'USDT' | 'TRX', chain: 'mainnet' | 'nile') => {
    const reason = f.chain !== null && f.chain !== chain ? 'chain_mismatch'
      : f.asset !== null && f.asset !== asset ? 'asset_mismatch' : null;
    return { ready: coreReady && reason === null, missingFields: [...missingFields, ...invalidFields], excludedReason: reason };
  };
  candidates.justlend_jusdt = forCandidate('USDT', 'mainnet');
  candidates.justlend_jtrx = forCandidate('TRX', 'nile');
  candidates.psm_jusdd = forCandidate('USDT', 'mainnet');
  if (f.acceptsUsddRisk !== true) {
    candidates.psm_jusdd.ready = false;
    if (f.acceptsUsddRisk === null && candidates.psm_jusdd.excludedReason === null) {
      candidates.psm_jusdd.missingFields.push('acceptsUsddRisk');
    } else if (f.acceptsUsddRisk === false) candidates.psm_jusdd.excludedReason = 'usdd_risk_declined';
  }
  const status: RequestValidation['status'] = coreReady
    ? request.confirmedVersion === request.version ? 'confirmed' : 'ready_for_confirmation' : 'incomplete';
  return { status, missingFields, invalidFields: [...new Set(invalidFields)], conflicts: request.conflicts, candidateInputs: candidates };
}

export function confirmAgentRequest(raw: unknown): AgentRequestState {
  const request = agentRequestStateSchema.parse(raw);
  const validation = validateAgentRequest(request);
  if (validation.status !== 'ready_for_confirmation' && validation.status !== 'confirmed') {
    throw new Error('확인 가능한 계획 입력이 아닙니다.');
  }
  return agentRequestStateSchema.parse({ ...request, confirmedVersion: request.version });
}

export function toUserNeeds(raw: unknown, observedToken?: Token): UserNeeds {
  const request = agentRequestStateSchema.parse(raw);
  const validation = validateAgentRequest(request);
  if (validation.status !== 'confirmed') throw new Error('확인된 계획 입력이 필요합니다.');
  const f = request.explicitFacts;
  if (f.chain === null || f.asset === null || f.statedHoldings === null || f.startDate === null
    || f.horizonDays === null || f.reserve === null || f.risk === null) throw new Error('계획 입력이 누락되었습니다.');
  const startDate = fieldDate(request, f.startDate, 'explicitFacts.startDate');
  if (startDate === null) throw new Error('시작 날짜의 기준 시각이 없습니다.');
  const token: Token = observedToken ?? { symbol: f.asset, address: null, decimals: f.asset === 'USDD' ? 18 : 6 };
  if (token.symbol !== f.asset) throw new Error('관측 토큰과 사용자 자산이 다릅니다.');
  const expenses = f.expenses.map((expense, index) => {
    if (!expense.due || !expense.amount || !expense.asset) throw new Error('지출 정보가 누락되었습니다.');
    const date = fieldDate(request, expense.due, `explicitFacts.expenses[${index}].due`);
    if (date === null) throw new Error('지출 날짜의 기준 시각이 없습니다.');
    return { date, amount: expense.amount, asset: token };
  });
  return userNeedsSchema.parse({
    chain: f.chain, asset: token, amount: f.statedHoldings, startDate,
    endDate: addDays(startDate, f.horizonDays), expenses, liquidReserve: f.reserve,
    riskPreference: f.risk, acceptsUsddRisk: f.acceptsUsddRisk === true,
    acceptsDatedExpenseLiquidityRisk: f.acceptsDatedExpenseLiquidityRisk === true,
    timezone: 'Asia/Seoul', inputVersion: request.version, confirmedVersion: request.confirmedVersion,
  });
}
