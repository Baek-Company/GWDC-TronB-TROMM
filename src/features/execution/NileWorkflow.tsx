import { useCallback, useEffect, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { actionPreviewSchema, dateSchema, observationSchema, planSchema, userNeedsSchema,
  type ExecutionRecord, type Observation, type Plan, type PositionFlow, type UserNeeds } from '../../../shared/schemas';
import { normalizeTronAddress } from '../../../shared/tron-address';
import { calculateLiquidity } from '../../../shared/planning';
import { canPreviewNileDeposit } from '../../../shared/execution-policy';
import type { NileDepositPreview, NileTransactionResult } from '../../../server/transactions';
import { PlanExplorer } from '../plans/PlanExplorer';
import { NileWithdrawalPanel } from './NileWithdrawalPanel';
import { browserNileApprovalGateway, listNileUnresolvedIntents, type NileUnresolvedIntent } from './approval-api';
import { cancelNileDepositReservation, executeNileDeposit, getNileExecutionRecord,
  PreviewChangedError, refreshNileExecutionRecord, synchronizeNileDepositIntent } from './index';
import { cancelNileWithdrawalReservation, getNileWithdrawalPreview, listNileWithdrawalRecords,
  refreshNileWithdrawalRecord, synchronizeNileWithdrawalIntent } from './withdraw';
import { seoulDate } from '../../lib/needs';
import { matchesConfirmedNileDepositFlow } from '../../lib/review-evidence';
import { getWalletEpoch, getWalletState } from '../../wallet';
import { matchesNileDepositPreview } from './preview-context';

const expenseInputSchema = z.object({ amount: z.string(), date: dateSchema });
const inputSchema = z.object({ amount: z.string(), horizonDays: z.string(), reserve: z.string(),
  expenses: z.array(expenseInputSchema).max(10), asOfDate: dateSchema,
  version: z.number().int().positive(), confirmedVersion: z.number().int().positive().nullable() });
type Inputs = z.infer<typeof inputSchema>;
const KEY = 'gwdc-nile-needs-v3';
const PREVIOUS_KEY = 'gwdc-nile-needs-v2';
const LEGACY_KEY = 'gwdc-nile-needs-v1';
const PLAN_SNAPSHOT_PREFIX = 'gwdc:nile-plan-snapshot:v1:';
const SAVE_ERROR = 'Nile 조건을 브라우저에 저장할 수 없습니다. 저장소를 확인한 뒤 다시 시도해 주세요. 저장 전에는 계획·미리보기·서명을 진행할 수 없습니다.';
const previousInputSchema = inputSchema.omit({ expenses: true, asOfDate: true })
  .extend({ expense: z.string(), expenseDate: z.string() });
const legacyInputSchema = previousInputSchema.omit({ expense: true, expenseDate: true });

function dateAfter(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function planSnapshotKey(planId: string, walletAddress: string): string {
  const wallet = normalizeTronAddress(walletAddress);
  if (!wallet) throw new Error('Nile 원 계획 사본을 지갑 주소와 연결할 수 없습니다.');
  return `${PLAN_SNAPSHOT_PREFIX}${wallet}:${planId}`;
}

function validNileRecoveryPlan(raw: Plan): Plan {
  const plan = planSchema.parse(raw);
  if (plan.chain !== 'nile' || plan.kind !== 'justlend_jtrx' ||
      !/^nile:justlend_jtrx:(80_20|50_50):v2:[0-9a-f]{64}$/.test(plan.id) ||
      !plan.quote || plan.quote.chain !== 'nile' || plan.quote.product !== 'justlend_jtrx' ||
      plan.quote.marketAddress === null || plan.quoteVersion !== plan.quote.quoteVersion ||
      plan.quote.receiptToken?.address !== plan.quote.marketAddress ||
      plan.inputToken.symbol !== 'TRX' || plan.inputToken.address !== null ||
      plan.depositToken.symbol !== 'TRX' || plan.depositToken.address !== null) {
    throw new Error('저장된 Nile 원 계획의 체인·계약·자산이 일치하지 않습니다.');
  }
  return plan;
}

export function recoverNilePlanSnapshot(planId: string, walletAddress: string,
  store: Pick<Storage, 'getItem'>): Plan | null {
  const key = planSnapshotKey(planId, walletAddress);
  let raw: string | null;
  try { raw = store.getItem(key); }
  catch { throw new Error('Nile 원 계획 사본 저장소를 읽을 수 없습니다.'); }
  if (raw === null) return null;
  try {
    const parsed = z.object({ walletAddress: z.string(), plan: planSchema }).parse(JSON.parse(raw) as unknown);
    if (normalizeTronAddress(parsed.walletAddress) !== normalizeTronAddress(walletAddress) ||
        parsed.plan.id !== planId) throw new Error('Plan snapshot mismatch');
    return validNileRecoveryPlan(parsed.plan);
  } catch { throw new Error('저장된 Nile 원 계획 사본이 손상되었거나 거래 대상과 다릅니다.'); }
}

export function persistNilePlanSnapshot(rawPlan: Plan, walletAddress: string,
  store: Pick<Storage, 'getItem' | 'setItem'>): void {
  const plan = validNileRecoveryPlan(rawPlan);
  const key = planSnapshotKey(plan.id, walletAddress);
  const prior = recoverNilePlanSnapshot(plan.id, walletAddress, store);
  if (prior) {
    if (prior.quoteVersion !== plan.quoteVersion || prior.needsVersion !== plan.needsVersion ||
        prior.startDate !== plan.startDate || prior.endDate !== plan.endDate ||
        prior.allocation.invested !== plan.allocation.invested ||
        prior.quote?.marketAddress !== plan.quote?.marketAddress) {
      throw new Error('같은 Nile 계획 ID에 다른 거래 조건이 저장되어 있습니다. 원 거래를 확인해 주세요.');
    }
    return;
  }
  const wallet = normalizeTronAddress(walletAddress)!;
  store.setItem(key, JSON.stringify({ walletAddress: wallet, plan }));
}

export function rolloverNileInputs(inputs: Inputs, today = seoulDate()): Inputs {
  return inputs.asOfDate === today ? inputs : { ...inputs, asOfDate: today,
    version: inputs.version + 1, confirmedVersion: null };
}

export function parseNileInputs(current: string | null, legacy: string | null, today = seoulDate(),
  previous: string | null = null): Inputs {
  if (current !== null) {
    try { return rolloverNileInputs(inputSchema.parse(JSON.parse(current) as unknown), today); }
    catch { /* Try the preserved prior version. */ }
  }
  if (previous !== null) {
    try {
      const old = previousInputSchema.parse(JSON.parse(previous) as unknown);
      return { amount: old.amount, horizonDays: old.horizonDays, reserve: old.reserve,
        expenses: old.expense === '0' ? [] : [{ amount: old.expense, date: old.expenseDate }],
        asOfDate: today, version: old.version + 1, confirmedVersion: null };
    } catch { /* Try the earlier version. */ }
  }
  if (legacy !== null) {
    try {
      const old = legacyInputSchema.parse(JSON.parse(legacy) as unknown);
      // Existing confirmed plans did not include a dated expense. Require a fresh confirmation.
      return { ...old, expenses: [], asOfDate: today,
        version: old.version + 1, confirmedVersion: null };
    } catch { /* Fall back to the example below. */ }
  }
  return { amount: '100', horizonDays: '30', expenses: [{ amount: '20', date: dateAfter(today, 7) }],
    reserve: '0', asOfDate: today, version: 1, confirmedVersion: null };
}

function loadInputs(): { inputs: Inputs; error: string } {
  try { return { inputs: parseNileInputs(localStorage.getItem(KEY), localStorage.getItem(LEGACY_KEY),
    seoulDate(), localStorage.getItem(PREVIOUS_KEY)), error: '' }; }
  catch { return { inputs: parseNileInputs(null, null), error: 'Nile 조건 저장소를 읽을 수 없습니다. 저장 상태를 확인할 때까지 거래를 진행할 수 없습니다.' }; }
}

export function persistNileInputs(inputs: Inputs, store: Pick<Storage, 'setItem'>): string {
  const snapshot = JSON.stringify(inputs);
  store.setItem(KEY, snapshot);
  return snapshot;
}

export function nileInputsToNeeds(inputs: Inputs, today = seoulDate()): UserNeeds {
  inputSchema.parse(inputs);
  if (inputs.asOfDate !== today) throw new Error('한국시간 날짜가 변경되었습니다. Nile 조건을 다시 확인해 주세요.');
  const horizonDays = Number(inputs.horizonDays);
  if (!/^\d+$/.test(inputs.horizonDays) || horizonDays < 1 || horizonDays > 3650) {
    throw new Error('운용 기간은 1~3650일의 정수여야 합니다.');
  }
  for (const [label, value] of [
    ['가상 계획 금액', inputs.amount], ['별도 예비액', inputs.reserve],
    ...inputs.expenses.map((expense, index) => [`${index + 1}번째 예정 지출액`, expense.amount] as const),
  ] as const) {
    if (!/^\d+(?:\.\d+)?$/.test(value) || new Decimal(value).decimalPlaces() > 6) {
      throw new Error(`${label}은 소수점 6자리 이내의 TRX 금액이어야 합니다.`);
    }
  }
  const asset = { symbol: 'TRX', address: null, decimals: 6 };
  const needs = userNeedsSchema.parse({ chain: 'nile', asset,
    amount: inputs.amount, startDate: today, endDate: dateAfter(today, horizonDays),
    expenses: inputs.expenses.filter(expense => new Decimal(expense.amount).gt(0))
      .map(expense => ({ date: expense.date, amount: expense.amount, asset })),
    liquidReserve: inputs.reserve, riskPreference: 'balanced', acceptsUsddRisk: false,
    timezone: 'Asia/Seoul', inputVersion: inputs.version, confirmedVersion: inputs.confirmedVersion });
  calculateLiquidity(needs);
  return needs;
}
async function postPreview(needs: UserNeeds, planId: string, address: string, signal?: AbortSignal): Promise<NileDepositPreview> {
  const response = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ needs, planId, address }), signal });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(z.object({ error: z.string() }).safeParse(data).data?.error || `HTTP ${response.status}`);
  actionPreviewSchema.parse(data);
  return data as NileDepositPreview;
}

export function NileWorkflow({ wallet, onConnect, selectedPlan, historicalRecords, positionFlows, verifiedDepositFlow,
  onSelect, onRestorePlan, onRecord,
  onOpeningObservation, onObservation, onWithdrawalFlow }: {
  wallet: ReturnType<typeof getWalletState>;
  onConnect: () => Promise<void>;
  selectedPlan: Plan | null;
  historicalRecords: ExecutionRecord[];
  positionFlows?: PositionFlow[];
  verifiedDepositFlow: PositionFlow | null;
  onSelect: (plan: Plan) => void;
  onRestorePlan: (plan: Plan) => void;
  onRecord: (record: ExecutionRecord) => void;
  onOpeningObservation: (observation: Observation, record: ExecutionRecord) => void;
  onObservation: (observation: Observation) => void;
  onWithdrawalFlow: (flow: PositionFlow) => void;
}) {
  const [loaded] = useState(loadInputs);
  const [inputs, setInputs] = useState(loaded.inputs);
  const [persistence, setPersistence] = useState({ snapshot: '', error: loaded.error });
  const [preview, setPreview] = useState<NileDepositPreview | null>(null);
  const [previewEpoch, setPreviewEpoch] = useState<number | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [recovery, setRecovery] = useState<{ address: string; intents: NileUnresolvedIntent[] } | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const requestGeneration = useRef(0);
  const previewAbort = useRef<AbortController | null>(null);
  const [, refreshStoredRecord] = useState(0);
  const snapshot = JSON.stringify(inputs);
  const persistenceReady = !persistence.error && persistence.snapshot === snapshot;
  const saveInputs = () => {
    try { setPersistence({ snapshot: persistNileInputs(inputs, localStorage), error: '' }); }
    catch { setPersistence({ snapshot: '', error: SAVE_ERROR }); }
  };
  useEffect(() => { saveInputs();
  // Persist the exact current input snapshot before a plan or preview may be used.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);
  const invalidatePreview = useCallback(() => {
    requestGeneration.current += 1;
    previewAbort.current?.abort();
    previewAbort.current = null;
    setPreview(null); setPreviewEpoch(null); setAcknowledged(false); setBusy(false);
  }, []);
  useEffect(() => {
    const checkDate = () => {
      const today = seoulDate();
      if (inputs.asOfDate === today) return;
      setInputs(current => rolloverNileInputs(current, today));
      invalidatePreview();
      setMessage('한국시간 날짜가 변경되어 이전 확인과 미리보기를 취소했습니다. Nile 조건을 다시 확인해 주세요.');
    };
    const interval = window.setInterval(checkDate, 30_000);
    window.addEventListener('focus', checkDate);
    document.addEventListener('visibilitychange', checkDate);
    checkDate();
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', checkDate);
      document.removeEventListener('visibilitychange', checkDate);
    };
  }, [inputs.asOfDate, invalidatePreview]);
  const ensureCurrentDay = () => {
    if (inputs.asOfDate === seoulDate()) return true;
    setInputs(current => rolloverNileInputs(current));
    invalidatePreview();
    setMessage('한국시간 날짜가 변경되었습니다. Nile 조건을 다시 확인해 주세요.');
    return false;
  };
  const edit = (field: 'amount' | 'horizonDays' | 'reserve', value: string) => {
    setInputs(current => ({ ...current, [field]: value, version: current.version + 1, confirmedVersion: null }));
    invalidatePreview();
  };
  const editExpense = (index: number, field: 'amount' | 'date', value: string) => {
    setInputs(current => ({ ...current, expenses: current.expenses.map((expense, position) =>
      position === index ? { ...expense, [field]: value } : expense),
    version: current.version + 1, confirmedVersion: null }));
    invalidatePreview();
  };
  const addExpense = () => {
    setInputs(current => ({ ...current, expenses: [...current.expenses, { amount: '0', date: seoulDate(7) }],
      version: current.version + 1, confirmedVersion: null }));
    invalidatePreview();
  };
  const removeExpense = (index: number) => {
    setInputs(current => ({ ...current, expenses: current.expenses.filter((_, position) => position !== index),
      version: current.version + 1, confirmedVersion: null }));
    invalidatePreview();
  };
  const applyExpenseExample = () => {
    setInputs(current => ({ ...current, expenses: [{ amount: '20', date: seoulDate(7) }],
      version: current.version + 1, confirmedVersion: null }));
    invalidatePreview();
  };
  let needs: UserNeeds | null = null;
  let needsError = '';
  try {
    needs = nileInputsToNeeds(inputs);
  } catch (cause) { needsError = cause instanceof Error && !(cause instanceof z.ZodError)
    ? cause.message : 'TRX 금액·1~3650일 운용 기간·지출 날짜와 금액·예비액을 확인해 주세요.'; }
  const liquidity = needs ? calculateLiquidity(needs) : null;
  const recoveryPlan = selectedPlan?.chain === 'nile' ? selectedPlan : null;
  // A changed date invalidates new deposits, but does not erase the original plan needed to redeem.
  const plan = recoveryPlan && needs && recoveryPlan.needsVersion === inputs.version
    && recoveryPlan.startDate === needs.startDate && recoveryPlan.endDate === needs.endDate ? recoveryPlan : null;
  const context = `${plan?.id ?? ''}|${plan?.quoteVersion ?? ''}|${inputs.version}|${inputs.amount}|${wallet.address ?? ''}|${wallet.networkKey}|${getWalletEpoch()}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => {
    invalidatePreview();
    return () => { requestGeneration.current += 1; previewAbort.current?.abort(); };
  // Wallet events also invalidate previews when the account or chain later returns to its prior value.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith('gwdc:nile-execution:') || event.key?.startsWith('gwdc:nile-transaction:')) {
        refreshStoredRecord(value => value + 1);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  let storedRecordError = '';
  let record: ExecutionRecord | null = null;
  let recordFromStorage = false;
  if (recoveryPlan && wallet.address) {
    try {
      record = getNileExecutionRecord(recoveryPlan.id, wallet.address);
      recordFromStorage = record !== null;
      if (!record) record = historicalRecords.find(item => item.action === 'deposit' &&
        item.chain === 'nile' && item.planId === recoveryPlan.id &&
        item.walletAddress === wallet.address && item.txId !== null) ?? null;
    }
    catch (cause) { storedRecordError = cause instanceof Error ? cause.message : '저장된 거래 기록을 확인할 수 없습니다.'; }
  }
  const priorRecords = wallet.address ? historicalRecords.filter(item => item.action === 'deposit' &&
    item.chain === 'nile' && item.walletAddress === wallet.address && item.txId !== null &&
    item.status !== 'rejected' &&
    item.planId !== recoveryPlan?.id) : [];
  const priorPlans = priorRecords.map(item => {
    try {
      const savedPlan = recoverNilePlanSnapshot(item.planId, item.walletAddress, localStorage);
      if (!savedPlan) return { record: item, plan: null, error: '원 계획 사본이 없어 앱에서 복구할 수 없습니다.' };
      if (item.contractAddress !== savedPlan.quote?.marketAddress) {
        throw new Error('원 거래의 계약과 저장된 계획 사본이 다릅니다.');
      }
      return { record: item, plan: savedPlan, error: '' };
    } catch (cause) {
      return { record: item, plan: null, error: cause instanceof Error ? cause.message : '원 계획 사본을 확인할 수 없습니다.' };
    }
  });
  const canPreview = needs && plan && persistenceReady && wallet.networkKey === 'nile'
    && canPreviewNileDeposit(plan) && !storedRecordError;
  const activePreview = persistenceReady && inputs.asOfDate === seoulDate()
    && previewEpoch === getWalletEpoch()
    && matchesNileDepositPreview(preview, plan, inputs.version, wallet.address, wallet.networkKey)
    ? preview : null;
  const verifiedDeposit = recordFromStorage &&
    matchesConfirmedNileDepositFlow(recoveryPlan, record, verifiedDepositFlow);
  const tentativeDepositId = !!record?.txId && record.submittedAt === null &&
    (record.status === 'unknown' || record.status === 'rejected');
  const recoveryIntents = recovery?.address === wallet.address && wallet.networkKey === 'nile'
    ? recovery.intents : [];
  const recoveryBlocked = recoveryIntents.length > 0;

  const recoverServerIntents = async () => {
    if (!wallet.address || wallet.networkKey !== 'nile') return;
    setRecoveryBusy(true); setRecoveryMessage('');
    try {
      await browserNileApprovalGateway.authenticate(wallet.address);
      const intents = await listNileUnresolvedIntents(wallet.address);
      setRecovery({ address: wallet.address, intents });
      for (const intent of intents) {
        const savedPlan = recoverNilePlanSnapshot(intent.planId, wallet.address, localStorage);
        if (savedPlan && (savedPlan.quoteVersion !== intent.quoteVersion ||
            savedPlan.quote?.marketAddress !== intent.targetContract)) {
          throw new Error('원 계획 사본과 서버 미해결 의도의 견적·계약이 다릅니다.');
        }
        if (intent.action === 'deposit') {
          await synchronizeNileDepositIntent({ intent, onRecord });
        } else {
          await synchronizeNileWithdrawalIntent({ intent, onRecord });
        }
      }
      setRecoveryRevision(value => value + 1);
      setRecoveryMessage(intents.length ? `${intents.length}건의 서버 미해결 거래를 확인했습니다. 원 txID를 조회하거나 서명 전 예약을 취소해 주세요.`
        : '이 지갑의 서버 미해결 거래가 없습니다.');
    } catch (cause) {
      setRecoveryMessage(cause instanceof Error ? cause.message : '서버 거래 복구에 실패했습니다. 새 서명을 진행하지 마세요.');
    } finally { setRecoveryBusy(false); }
  };

  const cancelServerReservation = async (intent: NileUnresolvedIntent) => {
    if (!wallet.address || wallet.networkKey !== 'nile' || intent.account !== wallet.address) return;
    setRecoveryBusy(true); setRecoveryMessage('');
    try {
      await browserNileApprovalGateway.authenticate(wallet.address);
      const latest = (await listNileUnresolvedIntents(wallet.address)).find(item => item.id === intent.id);
      if (!latest || latest.status !== 'reserved') {
        throw new Error('서버 예약 상태가 바뀌었습니다. 미해결 거래를 다시 확인해 주세요.');
      }
      if (latest.action === 'deposit') {
        await cancelNileDepositReservation({ intent: latest, approval: browserNileApprovalGateway, onRecord });
      } else {
        await cancelNileWithdrawalReservation({ intent: latest, approval: browserNileApprovalGateway, onRecord });
      }
      setRecovery(current => current?.address === wallet.address
        ? { ...current, intents: current.intents.filter(item => item.id !== intent.id) } : current);
      setRecoveryRevision(value => value + 1);
      setRecoveryMessage('서버의 서명 전 예약 취소를 확인했습니다. 새 미리보기부터 진행해 주세요.');
    } catch (cause) {
      setRecoveryMessage(cause instanceof Error ? cause.message : '예약 취소를 확인할 수 없습니다. 새 서명을 진행하지 마세요.');
    } finally { setRecoveryBusy(false); }
  };

  const refreshRecoveredIntent = async (intent: NileUnresolvedIntent) => {
    if (!wallet.address || wallet.networkKey !== 'nile' || !intent.txId) return;
    setRecoveryBusy(true); setRecoveryMessage('');
    try {
      const readTransaction = async (txId: string) => {
        const response = await fetch(`/api/transactions/${encodeURIComponent(txId)}`);
        if (!response.ok) throw new Error('원 거래 조회에 실패했습니다.');
        return await response.json() as NileTransactionResult;
      };
      let status: ExecutionRecord['status'];
      if (intent.action === 'deposit') {
        const current = getNileExecutionRecord(intent.planId, wallet.address);
        if (!current || current.approvalIntentId !== intent.id || current.txId !== intent.txId) {
          throw new Error('로컬 예치 기록과 서버 원 txID가 다릅니다.');
        }
        const result = await refreshNileExecutionRecord({ record: current, approval: browserNileApprovalGateway,
          readTransaction, onRecord });
        status = result.record.status;
      } else {
        const current = listNileWithdrawalRecords(intent.planId, wallet.address)
          .find(item => item.approvalIntentId === intent.id);
        if (!current || current.txId !== intent.txId) {
          throw new Error('로컬 환매 기록과 서버 원 txID가 다릅니다.');
        }
        const preview = getNileWithdrawalPreview(intent.planId, wallet.address) ?? undefined;
        const result = await refreshNileWithdrawalRecord({ record: current, preview,
          approval: browserNileApprovalGateway, readTransaction, onRecord });
        status = result.record.status;
      }
      if (status === 'confirmed' || status === 'failed') {
        setRecovery(current => current?.address === wallet.address
          ? { ...current, intents: current.intents.filter(item => item.id !== intent.id) } : current);
      }
      setRecoveryRevision(value => value + 1);
      setRecoveryMessage(`원 txID ${intent.txId} · 상태 ${status}`);
    } catch (cause) {
      setRecoveryMessage(cause instanceof Error ? cause.message : '원 txID 조회에 실패했습니다.');
    } finally { setRecoveryBusy(false); }
  };

  const requestPreview = async () => {
    if (!ensureCurrentDay() || !needs || !plan || !wallet.address || !canPreview || recoveryBlocked || recoveryBusy) return;
    const requestedWalletEpoch = getWalletEpoch();
    const generation = ++requestGeneration.current;
    const requestedContext = context;
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    setBusy(true); setMessage(''); setPreview(null); setPreviewEpoch(null); setAcknowledged(false);
    try {
      persistNilePlanSnapshot(plan, wallet.address, localStorage);
      const result = await postPreview(needs, plan.id, wallet.address, controller.signal);
      if (generation !== requestGeneration.current || requestedContext !== contextRef.current ||
          requestedWalletEpoch !== getWalletEpoch()) return;
      if (!matchesNileDepositPreview(result, plan, inputs.version, wallet.address, wallet.networkKey)) {
        throw new Error('응답의 Nile 거래 조건이 현재 입력과 다릅니다.');
      }
      setPreview(result); setPreviewEpoch(requestedWalletEpoch);
    } catch (cause) {
      if (generation !== requestGeneration.current || controller.signal.aborted) return;
      setPreview(null); setPreviewEpoch(null); setMessage(cause instanceof Error ? cause.message : 'Nile 미리보기 실패');
    } finally {
      if (generation === requestGeneration.current) { setBusy(false); previewAbort.current = null; }
    }
  };
  const execute = async () => {
    if (!ensureCurrentDay() || !needs || !plan || !activePreview || !acknowledged || !wallet.address || !canPreview || recoveryBlocked || recoveryBusy) return;
    setBusy(true); setMessage('');
    try {
      persistNilePlanSnapshot(plan, wallet.address, localStorage);
      const result = await executeNileDeposit({ preview: activePreview, confirmPreviewId: activePreview.id,
        expectedWalletEpoch: previewEpoch!,
        confirmedNeeds: needs,
        approval: browserNileApprovalGateway,
        assertBeforeSign: () => {
          if (inputs.asOfDate !== seoulDate() || localStorage.getItem(KEY) !== JSON.stringify(inputs)) {
            throw new Error('한국시간 날짜 또는 저장된 Nile 조건이 변경되어 서명을 중단했습니다. 조건을 다시 확인해 주세요.');
          }
        },
        refreshPreview: () => {
          if (inputs.asOfDate !== seoulDate()) throw new Error('한국시간 날짜가 변경되어 서명을 중단했습니다.');
          return postPreview(needs, plan.id, wallet.address);
        }, onRecord,
        readOpeningObservation: async current => {
          if (inputs.asOfDate !== seoulDate()) throw new Error('한국시간 날짜가 변경되어 서명을 중단했습니다.');
          const params = new URLSearchParams({ planId: current.planId, address: current.walletAddress });
          const response = await fetch(`/api/observe?${params}`);
          if (!response.ok) throw new Error('예치 전 동일 Nile 포지션 관측에 실패했습니다. 서명을 중단했습니다.');
          const observation = observationSchema.parse(await response.json());
          if (inputs.asOfDate !== seoulDate()) throw new Error('한국시간 날짜가 변경되어 서명을 중단했습니다.');
          return observation;
        },
        onOpeningObservation: async (observation, record) => {
          await onOpeningObservation(observation, record);
          if (inputs.asOfDate !== seoulDate()) throw new Error('한국시간 날짜가 변경되어 서명을 중단했습니다.');
        },
      });
      setPreview(null); setPreviewEpoch(null); setAcknowledged(false);
      setMessage(result.txId ? `원 거래 ID: ${result.txId} · 상태: ${result.status}` : `거래 상태: ${result.status}`);
    } catch (cause) {
      if (cause instanceof PreviewChangedError) { setPreview(cause.updatedPreview); setAcknowledged(false); }
      setMessage(cause instanceof Error ? cause.message : '거래 진행 실패');
    } finally { setBusy(false); }
  };
  const refreshRecord = async (target: ExecutionRecord) => {
    setBusy(true); setMessage('');
    try {
      const result = await refreshNileExecutionRecord({ record: target,
        approval: browserNileApprovalGateway,
        readTransaction: async txId => {
          const response = await fetch(`/api/transactions/${encodeURIComponent(txId)}`);
          if (!response.ok) throw new Error('원 거래 조회에 실패했습니다.');
          return await response.json() as NileTransactionResult;
        },
        readObservation: async current => {
          const params = new URLSearchParams({ planId: current.planId, address: current.walletAddress });
          const response = await fetch(`/api/observe?${params}`);
          if (!response.ok) throw new Error('동일 Nile 포지션 조회에 실패했습니다.');
          return await response.json() as Observation;
        }, onRecord,
      });
      if (result.observation) onObservation(result.observation);
      setMessage(`원 거래 조회: ${result.record.status}${result.observation ? ' · jTRX 포지션 재조회 완료' : ''}`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '원 거래 조회 실패'); }
    finally { setBusy(false); }
  };

  return <section className="nile-workflow">
    <div className="section-intro"><div><p className="overline">NILE / TECHNICAL TEST</p><h2>Nile TRX·jTRX 예치 및 회수 시연</h2><p>테스트 자산으로 Nile 계획, 계약, 수수료와 거래 기록을 확인합니다. USDT 가정 결과와 성과를 합치지 않습니다.</p></div><span className="section-badge amber">Nile 테스트넷</span></div>
    <div className="surface nile-inputs">
      <div className="panel-head"><div><span className="panel-step">N</span><h3>Nile 시연 조건</h3></div><button type="button" className="text-button" onClick={() => void onConnect()}>{wallet.address ? '지갑 다시 확인' : 'TronLink 연결'}</button></div>
      <p className="nile-wallet">{wallet.address ? `${wallet.network} · ${wallet.address}` : 'TronLink 주소가 연결되지 않았습니다.'}</p>
      {wallet.address && <button type="button" className="refresh-button"
        disabled={busy || recoveryBusy || wallet.networkKey !== 'nile'}
        onClick={() => void recoverServerIntents()}>서버 미해결 거래 확인·복구</button>}
      {recovery?.address === wallet.address && recoveryIntents.map(intent => <div className="nile-record" key={intent.id}>
        <p>서버 거래 의도: {intent.action === 'deposit' ? '예치' : '환매'} · {intent.status} · 계획 {intent.planId}</p>
        <p>원 txID {intent.txId ?? '서명 전 예약'}</p>
        {intent.status === 'reserved'
          ? <button type="button" className="refresh-button" disabled={busy || recoveryBusy}
            onClick={() => void cancelServerReservation(intent)}>서명 전 예약 취소</button>
          : <button type="button" className="refresh-button" disabled={busy || recoveryBusy || !intent.txId}
            onClick={() => void refreshRecoveredIntent(intent)}>원 txID 다시 조회</button>}
      </div>)}
      {recoveryMessage && <p className="market-state" role="status">{recoveryMessage}</p>}
      <div className="nile-input-grid">
        <label><span>가상 계획 금액</span><span className="nile-field-control"><input value={inputs.amount} onChange={event => edit('amount', event.target.value)} inputMode="decimal" /><small>TRX</small></span></label>
        <label><span>운용 기간</span><span className="nile-field-control"><input value={inputs.horizonDays} onChange={event => edit('horizonDays', event.target.value)} inputMode="numeric" /><small>일</small></span></label>
        <label><span>별도 예비액</span><span className="nile-field-control"><input value={inputs.reserve} onChange={event => edit('reserve', event.target.value)} inputMode="decimal" /><small>TRX</small></span></label>
      </div>
      <div className="nile-expense-head"><strong>예정 지출 일정</strong><span>날짜별 금액을 모두 별도로 보호합니다. 최대 10건</span></div>
      <div className="nile-expense-list">{inputs.expenses.length === 0 && <p>등록된 예정 지출이 없습니다.</p>}
        {inputs.expenses.map((expense, index) => <div className="nile-expense-row" key={index}>
          <label><span>{index + 1}번째 예정 지출액</span><span className="nile-field-control"><input value={expense.amount} onChange={event => editExpense(index, 'amount', event.target.value)} inputMode="decimal" /><small>TRX</small></span></label>
          <label><span>{index + 1}번째 지출 날짜</span><input type="date" value={expense.date} onChange={event => editExpense(index, 'date', event.target.value)} /></label>
          <button type="button" className="text-button" onClick={() => removeExpense(index)} aria-label={`${index + 1}번째 예정 지출 삭제`}>삭제</button>
        </div>)}</div>
      <div className="nile-expense-actions"><button type="button" className="text-button" disabled={inputs.expenses.length >= 10} onClick={addExpense}>지출 추가</button>
        <button type="button" className="text-button" onClick={applyExpenseExample}>7일 뒤 20 TRX 예시 지출 적용</button></div>
      {needsError && <p className="input-error" role="alert">{needsError}</p>}
      {persistence.error && <div className="input-error" role="alert"><p>{persistence.error}</p>
        <button type="button" className="text-button" onClick={saveInputs}>저장 다시 시도</button></div>}
      {needs && liquidity && <div className="market-state" role="note">
        <strong>가상 자금 일정</strong>{needs.expenses.length > 0
          ? needs.expenses.map((expense, index) => <p key={`${expense.date}-${index}`}>{expense.date} 지출 {expense.amount} TRX</p>)
          : <p>예정 지출 없음</p>}<p>별도 예비액 {needs.liquidReserve} TRX</p>
        <p>지출·예비액 확보 {liquidity.protectedAmount} TRX · 전 기간 운용 상한 {liquidity.investableAmount} TRX</p>
        {needs.expenses.some(expense => expense.date > needs.endDate)
          && <p>운용 종료 뒤 예정된 지출도 지금부터 확보합니다.</p>}
        <small>계획 금액은 지출·예비액을 차감하기 전의 가상 입력이며 실제 Nile 지갑 잔고와 별도로 확인합니다. 지출일의 회수는 보장되지 않습니다.</small>
      </div>}
      <div className="needs-confirm"><p>입력 기준일 {inputs.asOfDate} · 버전 {inputs.version} · {inputs.confirmedVersion === inputs.version ? '확인됨' : '확인 전'}</p><button type="button" disabled={!needs || !persistenceReady || inputs.confirmedVersion === inputs.version} onClick={() => {
        if (ensureCurrentDay()) setInputs(current => ({ ...current, confirmedVersion: current.version }));
      }}>Nile 조건 확인</button></div>
    </div>
    <div className="nile-plans">{wallet.address ? <PlanExplorer needs={persistenceReady ? needs : null} endpoint="/api/nile/plans" walletAddress={wallet.address}
      nilePositionFlows={positionFlows} nileRecords={historicalRecords} onSelect={chosen => {
      if (ensureCurrentDay() && persistenceReady && chosen.chain === 'nile' && chosen.needsVersion === inputs.version && canPreviewNileDeposit(chosen)) {
        try {
          if (recoveryPlan) {
            const priorWallets = new Set(historicalRecords.filter(item => item.action === 'deposit' &&
              item.chain === 'nile' && item.planId === recoveryPlan.id).map(item => item.walletAddress));
            if (record?.planId === recoveryPlan.id) priorWallets.add(record.walletAddress);
            for (const priorWallet of priorWallets) persistNilePlanSnapshot(recoveryPlan, priorWallet, localStorage);
          }
          persistNilePlanSnapshot(chosen, wallet.address, localStorage);
          invalidatePreview(); onSelect(chosen);
        } catch (cause) {
          setMessage(cause instanceof Error ? cause.message : 'Nile 원 계획 사본을 저장할 수 없습니다.');
        }
      }
    }} /> : <div className="plan-gate"><strong>Nile 지갑 연결을 기다리고 있습니다.</strong><p>TronLink를 Nile로 전환하고 주소를 연결하면 이 시험망의 계획만 조회합니다.</p></div>}</div>
    {priorPlans.length > 0 && <div className="surface nile-record"><h3>이전 Nile 원 거래 복구</h3>
      <p>새 계획을 선택해도 이전 원 txID는 별도로 남습니다. 원 계획 사본을 다시 선택하면 영수증과 포지션을 조회할 수 있습니다.</p>
      {priorPlans.map(item => <div key={item.record.id}>
        <p>원 txID {item.record.txId} · 상태 {item.record.status} · 계획 {item.record.planId}</p>
        {item.error && <p className="market-state error">{item.error}</p>}
        {item.plan && <button type="button" className="refresh-button" disabled={busy}
          onClick={() => {
            try { onRestorePlan(item.plan!); }
            catch (cause) { setMessage(cause instanceof Error ? cause.message : '원 계획을 복구할 수 없습니다.'); }
          }}>이 계획의 원 거래 열기</button>}
      </div>)}
    </div>}
    {plan && <div className="surface nile-execution"><h3>선택한 계획 · {plan.scenario}</h3><p>{plan.allocation.invested} TRX · 계획 ID {plan.id}</p><p>연환산 금리나 출금 왕복 비용이 미확인인 경우 수익 권고가 아닙니다. 예치 직전의 계약·잔고·수수료만 별도로 확인합니다.</p>
      <button type="button" className="plan-select" disabled={!canPreview || busy || recoveryBusy || recoveryBlocked || !!record && ['awaiting_signature', 'submitted', 'pending', 'unknown', 'confirmed'].includes(record.status)} onClick={() => void requestPreview()}>Nile 예치 미리보기</button>
      {wallet.networkKey !== 'nile' && <p className="plan-warning">TronLink를 Nile 테스트넷으로 전환해 주세요.</p>}
    </div>}
    {recoveryPlan && !plan && record && <div className="surface nile-execution">
      <h3>기존 Nile 거래 복구</h3>
      <p>계획 입력일이 바뀌어 이 계획으로 새 예치는 할 수 없습니다. 원 txID와 같은 지갑의 포지션을 다시 확인한 뒤 기존 jTRX를 환매할 수 있습니다.</p>
      <p>원 계획 ID {recoveryPlan.id}</p>
    </div>}
    {activePreview && <div className="surface nile-preview"><h3>거래 전 최종 확인</h3><p><strong>금액</strong> {new Decimal(activePreview.amountBaseUnits).div('1000000').toString()} TRX</p><p><strong>계약</strong> {activePreview.contractAddress}</p><p><strong>예상 수수료</strong> {new Decimal(activePreview.estimatedFeeBaseUnits || '0').div('1000000').toString()} TRX · <strong>최대 수수료</strong> {new Decimal(activePreview.maxFeeBaseUnits || '0').div('1000000').toString()} TRX</p><p><strong>만료</strong> {new Date(activePreview.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p><ul>{activePreview.risks.map(risk => <li key={risk}>{risk}</li>)}</ul>
      <label className="usdd-risk"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />Nile 시험 거래의 금액·계약·수수료 상한·출금 위험을 확인했습니다.</label>
      <button type="button" className="plan-select" disabled={!acknowledged || !canPreview || busy || recoveryBusy || recoveryBlocked} onClick={() => void execute()}>TronLink 서명 요청</button>
    </div>}
    {record && <div className="surface nile-record"><h3>원 거래 기록</h3><p>상태 {record.status} · {tentativeDepositId
      ? record.status === 'rejected' ? '취소된 미방송 서명 ID' : '서버 접수 미확인 서명 ID' : 'ID'} {record.txId ?? '서명 전'}</p>{record.txId && !tentativeDepositId && <button type="button" className="plan-select" disabled={busy} onClick={() => void refreshRecord(record)}>확정 영수증과 포지션 다시 조회</button>}</div>}
    {recoveryPlan && wallet.address && record?.status === 'confirmed' && !verifiedDeposit &&
      <p className="market-state" role="status">같은 Nile jTRX 포지션의 예치 전후 잔고 증가가 확인되지 않았습니다. 원 거래와 포지션을 다시 조회해 주세요.</p>}
    {recoveryPlan && wallet.address && record?.status === 'confirmed' && verifiedDeposit && persistenceReady &&
      <NileWithdrawalPanel plan={recoveryPlan} address={wallet.address}
      networkKey={wallet.networkKey} depositRecord={record} recoveryBlocked={recoveryBlocked || recoveryBusy}
      recoveryRevision={recoveryRevision}
      onRecord={onRecord} onObservation={onObservation}
      onWithdrawalFlow={onWithdrawalFlow} />}
    {storedRecordError && <div className="market-state error" role="alert">{storedRecordError}</div>}
    {message && <p className="market-state" role="status">{message}</p>}
  </section>;
}
