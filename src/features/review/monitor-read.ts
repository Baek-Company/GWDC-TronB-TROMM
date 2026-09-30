import { z } from 'zod';
import type { AgentRequestState } from '../../../shared/agent-request';
import { datedAllocationSchema, decimalStringSchema, instantSchema, planSchema, sourceSchema, tokenSchema,
  type DatedAllocation, type Plan, type UserNeeds } from '../../../shared/schemas';
import { datedPositionState, remainingMonitorNeeds, type DatedPositionState, type GoalMonitorWallet } from './goal-monitor';
import type { MonitorDiagnostic } from './monitor-diagnostics';

const diagnosticsSchema = z.array(z.object({
  name: z.string(), status: z.enum(['ready', 'unknown', 'unavailable']),
  reason: z.string().nullable(),
})).default([]);
const plansResponse = z.object({ plans: z.array(planSchema), datedAllocation: datedAllocationSchema.nullable().optional(),
  diagnostics: diagnosticsSchema });
const positionSchema = z.object({
  status: z.enum(['ready', 'unknown', 'unavailable']), receiptToken: tokenSchema,
  receiptBalanceBaseUnits: z.string().regex(/^\d+$/).nullable().optional(),
  marketVerified: z.boolean().optional(),
  underlyingToken: tokenSchema, underlyingValue: decimalStringSchema.nullable(),
  source: sourceSchema.nullable(),
});
const assessmentResponse = z.object({
  assessedAt: instantSchema,
  plans: z.array(planSchema),
  datedAllocation: datedAllocationSchema.nullable().optional(),
  walletAddress: z.string().nullable(),
  observedWalletBalance: decimalStringSchema.nullable(),
  walletBalanceSource: sourceSchema.nullable(),
  observedPosition: positionSchema.nullable().optional(),
  observedFeeBalance: z.object({ amount: decimalStringSchema.nullable(), source: sourceSchema.nullable() }).nullable().optional(),
  balanceReason: z.string().nullable().optional(),
  diagnostics: diagnosticsSchema,
  dataMode: z.enum(['live', 'mixed_or_unavailable']),
});
const portfolioResponse = z.object({
  chain: z.enum(['mainnet', 'nile']), walletAddress: z.string(),
  walletBalance: z.object({
    status: z.enum(['ready', 'unknown', 'unavailable']), token: tokenSchema,
    amount: decimalStringSchema.nullable(), source: sourceSchema.nullable(),
    reason: z.string().nullable().optional(),
  }),
  position: positionSchema,
});

export type GoalMonitorRead = {
  checkedAt: string;
  latestPlan: Plan | null;
  datedAllocation: DatedAllocation | null;
  wallet: GoalMonitorWallet | null;
  walletIssue: string | null;
  balanceReason: string | null;
  diagnostics: MonitorDiagnostic[];
  dataMode: 'live' | 'mixed_or_unavailable' | null;
  positionState: DatedPositionState;
  feeTrxAmount: string | null;
};

async function json(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `HTTP ${response.status}`);
  }
  return body;
}

async function post(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  return json(await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), cache: 'no-store', signal,
  }));
}

function matchingPlan(plans: Plan[], original: Plan): Plan | null {
  return plans.find(plan => plan.kind === original.kind && plan.scenario === original.scenario
    && plan.chain === original.chain) ?? null;
}

async function readManualPortfolio(needs: UserNeeds, address: string, signal: AbortSignal): Promise<{
  wallet: GoalMonitorWallet; balanceReason: string | null;
}> {
  await json(await fetch('/api/agent/session', { cache: 'no-store', signal }));
  const value = portfolioResponse.parse(await post('/api/agent/portfolio', {
    chain: needs.chain, address,
    declaredHoldings: { asset: needs.asset.symbol, amount: needs.amount },
  }, signal));
  if (value.chain !== needs.chain || value.walletAddress !== address) {
    throw new Error('지갑 조회 결과의 체인·주소가 선택한 지갑과 다릅니다.');
  }
  return {
    wallet: {
      address: value.walletAddress,
      balance: value.walletBalance.status === 'ready' ? value.walletBalance.amount : null,
      balanceToken: value.walletBalance.token,
      balanceSource: value.walletBalance.source,
      position: value.position,
    },
    balanceReason: value.walletBalance.reason ?? null,
  };
}

export async function readGoalMonitor(input: {
  originalPlan: Plan | null;
  originalAllocation?: DatedAllocation | null;
  currentNeeds: UserNeeds;
  agentRequest: AgentRequestState | null;
  address: string | null;
  signal: AbortSignal;
  now?: Date;
}): Promise<GoalMonitorRead> {
  const remainingNeeds = remainingMonitorNeeds(input.currentNeeds, input.now ?? new Date());
  if (!remainingNeeds) throw new Error('지난 지출 또는 종료일이 있어 목표 조건을 먼저 다시 확인해야 합니다.');
  if (input.agentRequest) {
    await json(await fetch('/api/agent/session', { cache: 'no-store', signal: input.signal }));
    const result = assessmentResponse.parse(await post('/api/agent/assessment', {
      request: input.agentRequest, ...(input.address ? { address: input.address } : {}),
      ...(remainingNeeds.startDate !== input.currentNeeds.startDate
        ? { asOfDate: remainingNeeds.startDate } : {}),
    }, input.signal));
    const wallet: GoalMonitorWallet | null = result.walletAddress ? {
      address: result.walletAddress, balance: result.observedWalletBalance,
      balanceToken: input.currentNeeds.asset, balanceSource: result.walletBalanceSource,
      position: result.observedPosition ?? null,
    } : null;
    return {
      checkedAt: result.assessedAt,
      latestPlan: input.originalPlan ? matchingPlan(result.plans, input.originalPlan) : null,
      datedAllocation: result.datedAllocation ?? null,
      wallet,
      walletIssue: result.observedWalletBalance === null ? '같은 체인·자산의 최신 지갑 잔액을 확인하지 못했습니다.' : null,
      balanceReason: result.balanceReason ?? null,
      diagnostics: result.diagnostics,
      dataMode: result.dataMode,
      positionState: datedPositionState(input.originalAllocation ?? null, wallet, input.now ?? new Date()),
      feeTrxAmount: result.observedFeeBalance?.amount ?? null,
    };
  }
  if (input.currentNeeds.chain === 'nile' && !input.address) {
    return { checkedAt: new Date().toISOString(), latestPlan: null, datedAllocation: null, wallet: null,
      walletIssue: 'Nile 지갑 주소를 연결해야 상품과 잔액을 재조회할 수 있습니다.',
      balanceReason: null, diagnostics: [], dataMode: null, positionState: 'unknown', feeTrxAmount: null };
  }
  const endpoint = input.currentNeeds.chain === 'nile' ? '/api/nile/plans' : '/api/plans';
  const response = plansResponse.parse(await post(endpoint, {
    needs: remainingNeeds,
    ...(input.currentNeeds.chain === 'nile' ? { address: input.address } : {}),
  }, input.signal));
  let wallet: GoalMonitorWallet | null = null;
  let walletIssue: string | null = null;
  let balanceReason: string | null = null;
  if (input.address) {
    try {
      const portfolio = await readManualPortfolio(input.currentNeeds, input.address, input.signal);
      wallet = portfolio.wallet;
      balanceReason = portfolio.balanceReason;
    }
    catch (error) {
      if (input.signal.aborted) throw error;
      walletIssue = error instanceof Error ? error.message : '지갑 실잔액 조회에 실패했습니다.';
    }
  } else walletIssue = '같은 체인에 연결된 TronLink 주소가 없습니다.';
  return { checkedAt: new Date().toISOString(), latestPlan: input.originalPlan
    ? matchingPlan(response.plans, input.originalPlan) : null,
  datedAllocation: response.datedAllocation ?? null, wallet, walletIssue,
  balanceReason, diagnostics: response.diagnostics, dataMode: null,
  positionState: datedPositionState(input.originalAllocation ?? null, wallet, input.now ?? new Date()),
  feeTrxAmount: null };
}
