import { localizeKnownText, useI18n } from '../../lib/i18n';
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
  const { t, locale } = useI18n();
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
        t,
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
    <div className="section-intro"><div><p className="overline">NILE / TECHNICAL TEST</p><h2>{t("Nile TRX·jTRX 예치 및 회수 시연", "Nile TRX·jTRX deposit and redemption demo")}</h2><p>{t("테스트 자산으로 Nile 계획, 계약, 수수료와 거래 기록을 확인합니다. USDT 가정 결과와 성과를 합치지 않습니다.", "Check Nile plans, contracts, fees, and transaction records using test assets. Results are kept separate from hypothetical USDT performance.")}</p></div><span className="section-badge amber">{t("Nile 테스트넷", "Nile testnet")}</span></div>
    <div className="surface nile-inputs">
      <div className="panel-head"><div><span className="panel-step">N</span><h3>{t("Nile 시연 조건", "Nile demo conditions")}</h3></div><button type="button" className="text-button" onClick={() => void onConnect()}>{wallet.address ? t('지갑 다시 확인', "Check wallet again") : t('TronLink 연결', "Connect TronLink")}</button></div>
      <p className="nile-wallet">{wallet.address ? `${localizeKnownText(wallet.network, t, workflowMessages)} · ${wallet.address}` : t('TronLink 주소가 연결되지 않았습니다.', "No TronLink address is connected.")}</p>
      {wallet.address && <button type="button" className="refresh-button"
        disabled={busy || recoveryBusy || wallet.networkKey !== 'nile'}
        onClick={() => void recoverServerIntents()}>{t("서버 미해결 거래 확인·복구", "Check and recover unresolved server transactions")}</button>}
      {recovery?.address === wallet.address && recoveryIntents.map(intent => <div className="nile-record" key={intent.id}>
        <p>{t("서버 거래 의도: ", "Server transaction intent: ")}{intent.action === 'deposit' ? t('예치', "Deposit") : t('환매', "Redemption")} · {intent.status}{t(" · 계획 ", " · Plan ")}{intent.planId}</p>
        <p>{t("원 txID ", "Original txID ")}{intent.txId ?? t('서명 전 예약', "Reservation before signing")}</p>
        {intent.status === 'reserved'
          ? <button type="button" className="refresh-button" disabled={busy || recoveryBusy}
            onClick={() => void cancelServerReservation(intent)}>{t("서명 전 예약 취소", "Cancel reservation before signing")}</button>
          : <button type="button" className="refresh-button" disabled={busy || recoveryBusy || !intent.txId}
            onClick={() => void refreshRecoveredIntent(intent)}>{t("원 txID 다시 조회", "Refresh original txID")}</button>}
      </div>)}
      {recoveryMessage && <p className="market-state" role="status">{localizeKnownText(recoveryMessage, t, workflowMessages)}</p>}
      <div className="nile-input-grid">
        <label><span>{t("가상 계획 금액", "Hypothetical plan amount")}</span><span className="nile-field-control"><input value={inputs.amount} onChange={event => edit('amount', event.target.value)} inputMode="decimal" /><small>TRX</small></span></label>
        <label><span>{t("운용 기간", "Investment period")}</span><span className="nile-field-control"><input value={inputs.horizonDays} onChange={event => edit('horizonDays', event.target.value)} inputMode="numeric" /><small>{t("일", "days")}</small></span></label>
        <label><span>{t("별도 예비액", "Separate reserve")}</span><span className="nile-field-control"><input value={inputs.reserve} onChange={event => edit('reserve', event.target.value)} inputMode="decimal" /><small>TRX</small></span></label>
      </div>
      <div className="nile-expense-head"><strong>{t("예정 지출 일정", "Scheduled expenses")}</strong><span>{t("날짜별 금액을 모두 별도로 보호합니다. 최대 10건", "Each dated amount is protected separately. Up to 10 expenses.")}</span></div>
      <div className="nile-expense-list">{inputs.expenses.length === 0 && <p>{t("등록된 예정 지출이 없습니다.", "No scheduled expenses have been added.")}</p>}
        {inputs.expenses.map((expense, index) => <div className="nile-expense-row" key={index}>
          <label><span>{t(`${index + 1}번째 예정 지출액`, `Scheduled expense ${index + 1} amount`)}</span><span className="nile-field-control"><input value={expense.amount} onChange={event => editExpense(index, 'amount', event.target.value)} inputMode="decimal" /><small>TRX</small></span></label>
          <label><span>{t(`${index + 1}번째 지출 날짜`, `Expense ${index + 1} date`)}</span><input type="date" value={expense.date} onChange={event => editExpense(index, 'date', event.target.value)} /></label>
          <button type="button" className="text-button" onClick={() => removeExpense(index)} aria-label={t(`${index + 1}번째 예정 지출 삭제`, `Remove scheduled expense ${index + 1}`)}>{t("삭제", "Remove")}</button>
        </div>)}</div>
      <div className="nile-expense-actions"><button type="button" className="text-button" disabled={inputs.expenses.length >= 10} onClick={addExpense}>{t("지출 추가", "Add expense")}</button>
        <button type="button" className="text-button" onClick={applyExpenseExample}>{t("7일 뒤 20 TRX 예시 지출 적용", "Apply example: 20 TRX expense in 7 days")}</button></div>
      {needsError && <p className="input-error" role="alert">{localizeKnownText(needsError, t, workflowMessages)}</p>}
      {persistence.error && <div className="input-error" role="alert"><p>{localizeKnownText(persistence.error, t, workflowMessages)}</p>
        <button type="button" className="text-button" onClick={saveInputs}>{t("저장 다시 시도", "Retry saving")}</button></div>}
      {needs && liquidity && <div className="market-state" role="note">
        <strong>{t("가상 자금 일정", "Hypothetical funds schedule")}</strong>{needs.expenses.length > 0
          ? needs.expenses.map((expense, index) => <p key={`${expense.date}-${index}`}>{expense.date}{t(" 지출 ", " Expense ")}{expense.amount} TRX</p>)
          : <p>{t("예정 지출 없음", "No scheduled expenses")}</p>}<p>{t("별도 예비액 ", "Separate reserve ")}{needs.liquidReserve} TRX</p>
        <p>{t("지출·예비액 확보 ", "Protected expenses and reserve ")}{liquidity.protectedAmount}{t(" TRX · 전 기간 운용 상한 ", " TRX · Investment limit for the full period ")}{liquidity.investableAmount} TRX</p>
        {needs.expenses.some(expense => expense.date > needs.endDate)
          && <p>{t("운용 종료 뒤 예정된 지출도 지금부터 확보합니다.", "Expenses scheduled after the investment period are also protected from today.")}</p>}
        <small>{t("계획 금액은 지출·예비액을 차감하기 전의 가상 입력이며 실제 Nile 지갑 잔고와 별도로 확인합니다. 지출일의 회수는 보장되지 않습니다.", "The plan amount is a hypothetical input before expenses and reserves. It is checked separately from the actual Nile wallet balance. Withdrawal by the expense date is not guaranteed.")}</small>
      </div>}
      <div className="needs-confirm"><p>{t("입력 기준일 ", "Input reference date ")}{inputs.asOfDate}{t(" · 버전 ", " · Version ")}{inputs.version} · {inputs.confirmedVersion === inputs.version ? t('확인됨', "Confirmed") : t('확인 전', "Not confirmed")}</p><button type="button" disabled={!needs || !persistenceReady || inputs.confirmedVersion === inputs.version} onClick={() => {
        if (ensureCurrentDay()) setInputs(current => ({ ...current, confirmedVersion: current.version }));
      }}>{t("Nile 조건 확인", "Confirm Nile conditions")}</button></div>
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
          setMessage(cause instanceof Error ? cause.message : t('Nile 원 계획 사본을 저장할 수 없습니다.', "Unable to save the original Nile plan snapshot."));
        }
      }
    }} /> : <div className="plan-gate"><strong>{t("Nile 지갑 연결을 기다리고 있습니다.", "Waiting for a Nile wallet connection.")}</strong><p>{t("TronLink를 Nile로 전환하고 주소를 연결하면 이 시험망의 계획만 조회합니다.", "Switch TronLink to Nile and connect an address to fetch plans for this testnet.")}</p></div>}</div>
    {priorPlans.length > 0 && <div className="surface nile-record"><h3>{t("이전 Nile 원 거래 복구", "Recover previous original Nile transactions")}</h3>
      <p>{t("새 계획을 선택해도 이전 원 txID는 별도로 남습니다. 원 계획 사본을 다시 선택하면 영수증과 포지션을 조회할 수 있습니다.", "Previous original txIDs remain saved when a new plan is selected. Reopen the original plan snapshot to check its receipt and position.")}</p>
      {priorPlans.map(item => <div key={item.record.id}>
        <p>{t("원 txID ", "Original txID ")}{item.record.txId}{t(" · 상태 ", " · Status ")}{item.record.status}{t(" · 계획 ", " · Plan ")}{item.record.planId}</p>
        {item.error && <p className="market-state error">{localizeKnownText(item.error, t, workflowMessages)}</p>}
        {item.plan && <button type="button" className="refresh-button" disabled={busy}
          onClick={() => {
            try { onRestorePlan(item.plan!); }
            catch (cause) { setMessage(cause instanceof Error ? cause.message : t('원 계획을 복구할 수 없습니다.', "Unable to recover the original plan.")); }
          }}>{t("이 계획의 원 거래 열기", "Open this plan’s original transaction")}</button>}
      </div>)}
    </div>}
    {plan && <div className="surface nile-execution"><h3>{t("선택한 계획 · ", "Selected plan · ")}{plan.scenario}</h3><p>{plan.allocation.invested}{t(" TRX · 계획 ID ", " TRX · Plan ID ")}{plan.id}</p><p>{t("연환산 금리나 출금 왕복 비용이 미확인인 경우 수익 권고가 아닙니다. 예치 직전의 계약·잔고·수수료만 별도로 확인합니다.", "This is not a yield recommendation when the annualized rate or deposit-and-redemption fees are unverified. Only the contract, balance, and fees immediately before deposit are checked separately.")}</p>
      <button type="button" className="plan-select" disabled={!canPreview || busy || recoveryBusy || recoveryBlocked || !!record && ['awaiting_signature', 'submitted', 'pending', 'unknown', 'confirmed'].includes(record.status)} onClick={() => void requestPreview()}>{t("Nile 예치 미리보기", "Preview Nile deposit")}</button>
      {wallet.networkKey !== 'nile' && <p className="plan-warning">{t("TronLink를 Nile 테스트넷으로 전환해 주세요.", "Switch TronLink to the Nile testnet.")}</p>}
    </div>}
    {recoveryPlan && !plan && record && <div className="surface nile-execution">
      <h3>{t("기존 Nile 거래 복구", "Recover an existing Nile transaction")}</h3>
      <p>{t("계획 입력일이 바뀌어 이 계획으로 새 예치는 할 수 없습니다. 원 txID와 같은 지갑의 포지션을 다시 확인한 뒤 기존 jTRX를 환매할 수 있습니다.", "The plan input date has changed, so new deposits under this plan are blocked. Check the original txID and the same wallet’s position again to redeem existing jTRX.")}</p>
      <p>{t("원 계획 ID ", "Original plan ID ")}{recoveryPlan.id}</p>
    </div>}
    {activePreview && <div className="surface nile-preview"><h3>{t("거래 전 최종 확인", "Final check before transacting")}</h3><p><strong>{t("금액", "Amount")}</strong> {new Decimal(activePreview.amountBaseUnits).div('1000000').toString()} TRX</p><p><strong>{t("계약", "Contract")}</strong> {activePreview.contractAddress}</p><p><strong>{t("예상 수수료", "Estimated fee")}</strong> {new Decimal(activePreview.estimatedFeeBaseUnits || '0').div('1000000').toString()} TRX · <strong>{t("최대 수수료", "Maximum fee")}</strong> {new Decimal(activePreview.maxFeeBaseUnits || '0').div('1000000').toString()} TRX</p><p><strong>{t("만료", "Expires")}</strong> {new Date(activePreview.expiresAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' })}</p><ul>{activePreview.risks.map(risk => <li key={risk}>{localizeKnownText(risk, t, workflowMessages)}</li>)}</ul>
      <label className="usdd-risk"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />{t("Nile 시험 거래의 금액·계약·수수료 상한·출금 위험을 확인했습니다.", "I have checked the Nile test transaction amount, contract, fee cap, and withdrawal risks.")}</label>
      <button type="button" className="plan-select" disabled={!acknowledged || !canPreview || busy || recoveryBusy || recoveryBlocked} onClick={() => void execute()}>{t("TronLink 서명 요청", "Request TronLink signature")}</button>
    </div>}
    {record && <div className="surface nile-record"><h3>{t("원 거래 기록", "Original transaction record")}</h3><p>{t("상태 ", "Status ")}{record.status} · {tentativeDepositId
      ? record.status === 'rejected' ? t('취소된 미방송 서명 ID', "Cancelled unbroadcast signature ID") : t('서버 접수 미확인 서명 ID', "Signature ID with unverified server acceptance") : 'ID'} {record.txId ?? t('서명 전', "Before signing")}</p>{record.txId && !tentativeDepositId && <button type="button" className="plan-select" disabled={busy} onClick={() => void refreshRecord(record)}>{t("확정 영수증과 포지션 다시 조회", "Refresh confirmed receipt and position")}</button>}</div>}
    {recoveryPlan && wallet.address && record?.status === 'confirmed' && !verifiedDeposit &&
      <p className="market-state" role="status">{t("같은 Nile jTRX 포지션의 예치 전후 잔고 증가가 확인되지 않았습니다. 원 거래와 포지션을 다시 조회해 주세요.", "A balance increase in the same Nile jTRX position has not been verified after the deposit. Refresh the original transaction and position.")}</p>}
    {recoveryPlan && wallet.address && record?.status === 'confirmed' && verifiedDeposit && persistenceReady &&
      <NileWithdrawalPanel plan={recoveryPlan} address={wallet.address}
      networkKey={wallet.networkKey} depositRecord={record} recoveryBlocked={recoveryBlocked || recoveryBusy}
      recoveryRevision={recoveryRevision}
      onRecord={onRecord} onObservation={onObservation}
      onWithdrawalFlow={onWithdrawalFlow} />}
    {storedRecordError && <div className="market-state error" role="alert">{localizeKnownText(storedRecordError, t, workflowMessages)}</div>}
    {message && <p className="market-state" role="status">{localizeKnownText(message, t, workflowMessages)}</p>}
  </section>;
}

// Keep saved diagnostics intact and translate their known text only when displayed.
const workflowMessages: readonly (readonly [string, string])[] = [
  ["Nile 조건을 브라우저에 저장할 수 없습니다. 저장소를 확인한 뒤 다시 시도해 주세요. 저장 전에는 계획·미리보기·서명을 진행할 수 없습니다.","Unable to save Nile conditions in this browser. Check storage and try again. Plans, previews, and signing remain blocked until saving succeeds."],
  ["한국시간 날짜 또는 저장된 Nile 조건이 변경되어 서명을 중단했습니다. 조건을 다시 확인해 주세요.","Signing stopped because the date in Korea or the saved Nile conditions changed. Confirm the conditions again."],
  ["한국시간 날짜가 변경되어 이전 확인과 미리보기를 취소했습니다. Nile 조건을 다시 확인해 주세요.","The date in Korea has changed, invalidating the previous confirmation and preview. Confirm the Nile conditions again."],
  ["Nile 조건 저장소를 읽을 수 없습니다. 저장 상태를 확인할 때까지 거래를 진행할 수 없습니다.","Unable to read Nile conditions from storage. Transactions remain blocked until the saved state is verified."],
  ["{0}건의 서버 미해결 거래를 확인했습니다. 원 txID를 조회하거나 서명 전 예약을 취소해 주세요.","{0} unresolved server transaction(s) found. Check the original txID or cancel the reservation before signing."],
  ["Energy와 Bandwidth 사용량은 추정치이며 최대 수수료 범위에서 변동될 수 있습니다.","Energy and Bandwidth usage are estimates and may vary within the maximum fee budget."],
  ["같은 Nile 계획 ID에 다른 거래 조건이 저장되어 있습니다. 원 거래를 확인해 주세요.","Different transaction terms are saved under the same Nile plan ID. Check the original transaction."],
  ["TRX 금액·1~3650일 운용 기간·지출 날짜와 금액·예비액을 확인해 주세요.","Check the TRX amount, investment period of 1–3650 days, expense dates and amounts, and reserve."],
  ["서버의 서명 전 예약 취소를 확인했습니다. 새 미리보기부터 진행해 주세요.","Cancellation of the server reservation before signing is confirmed. Start with a new preview."],
  ["예치 전 동일 Nile 포지션 관측에 실패했습니다. 서명을 중단했습니다.","Failed to observe the same Nile position before depositing. Signing stopped."],
  ["한국시간 날짜가 변경되었습니다. Nile 조건을 다시 확인해 주세요.","The date in Korea has changed. Confirm the Nile conditions again."],
  ["저장된 Nile 원 계획 사본이 손상되었거나 거래 대상과 다릅니다.","The saved original Nile plan snapshot is damaged or does not match the transaction."],
  ["서버 예약 상태가 바뀌었습니다. 미해결 거래를 다시 확인해 주세요.","The server reservation state has changed. Check unresolved transactions again."],
  ["{0}번째 예정 지출액은 소수점 6자리 이내의 TRX 금액이어야 합니다.","Scheduled expense {0} must be a TRX amount with no more than 6 decimal places."],
  ["다른 자산으로 지급할 지출에는 검증된 자산 전환 경로가 필요합니다.","An expense in another asset requires a verified conversion route."],
  ["가상 계획 금액은 소수점 6자리 이내의 TRX 금액이어야 합니다.","The hypothetical plan amount must be a TRX amount with no more than 6 decimal places."],
  ["저장된 Nile 원 계획의 체인·계약·자산이 일치하지 않습니다.","The chain, contract, or assets of the saved original Nile plan do not match."],
  ["예약 취소를 확인할 수 없습니다. 새 서명을 진행하지 마세요.","Unable to verify reservation cancellation. Do not sign a new transaction."],
  ["별도 예비액은 소수점 6자리 이내의 TRX 금액이어야 합니다.","The separate reserve must be a TRX amount with no more than 6 decimal places."],
  ["서버 거래 복구에 실패했습니다. 새 서명을 진행하지 마세요.","Server transaction recovery failed. Do not sign a new transaction."],
  ["Nile 원 계획 사본을 지갑 주소와 연결할 수 없습니다.","Unable to associate the original Nile plan snapshot with the wallet address."],
  ["원 계획 사본과 서버 미해결 의도의 견적·계약이 다릅니다.","The quote or contract in the original plan snapshot does not match the unresolved server intent."],
  ["예정 지출액과 여유액의 합계가 보유 금액보다 큽니다.","Scheduled expenses and reserves together exceed the available amount."],
  ["Nile 원 계획 사본 저장소를 읽을 수 없습니다.","Unable to read the original Nile plan snapshot storage."],
  ["응답의 Nile 거래 조건이 현재 입력과 다릅니다.","The returned Nile transaction terms do not match the current input."],
  ["원 계획 사본이 없어 앱에서 복구할 수 없습니다.","Recovery in the app is unavailable because the original plan snapshot is missing."],
  ["원 거래 조회: {0} · jTRX 포지션 재조회 완료","Original transaction check: {0} · jTRX position refreshed"],
  ["원 거래의 계약과 저장된 계획 사본이 다릅니다.","The original transaction contract does not match the saved plan snapshot."],
  ["로컬 예치 기록과 서버 원 txID가 다릅니다.","The local deposit record does not match the original server txID."],
  ["로컬 환매 기록과 서버 원 txID가 다릅니다.","The local redemption record does not match the original server txID."],
  ["운용 기간은 1~3650일의 정수여야 합니다.","The investment period must be a whole number between 1 and 3650 days."],
  ["한국시간 날짜가 변경되어 서명을 중단했습니다.","Signing stopped because the date in Korea changed."],
  ["금리·환율과 계약 유동성은 변할 수 있습니다.","Interest rates, exchange rates, and contract liquidity may change."],
  ["동일 Nile 포지션 조회에 실패했습니다.","Failed to fetch the same Nile position."],
  ["저장된 거래 기록을 확인할 수 없습니다.","Unable to verify the saved transaction record."],
  ["이 지갑의 서버 미해결 거래가 없습니다.","This wallet has no unresolved server transactions."],
  ["운용 기간은 1~3650일이어야 합니다.","The investment period must be between 1 and 3650 days."],
  ["원 계획 사본을 확인할 수 없습니다.","Unable to verify the original plan snapshot."],
  ["원 txID 조회에 실패했습니다.","Failed to fetch the original txID."],
  [" · jTRX 포지션 재조회 완료"," · jTRX position refreshed"],
  ["원 거래 조회에 실패했습니다.","Failed to fetch the original transaction."],
  ["원 거래 ID: {0} · 상태: {1}","Original transaction ID: {0} · Status: {1}"],
  ["원 txID {0} · 상태 {1}","Original txID {0} · Status {1}"],
  ["Nile 미리보기 실패","Nile preview failed"],
  ["원 거래 조회 실패","Failed to fetch the original transaction"],
  ["{0}번째 예정 지출액","Scheduled expense {0}"],
  ["원 거래 조회: {0}","Original transaction check: {0}"],
  ["가상 계획 금액","Hypothetical plan amount"],
  ["거래 진행 실패","Transaction failed to proceed"],
  ["거래 상태: {0}","Transaction status: {0}"],
  ["별도 예비액","Separate reserve"],
  ["이전 형식의 계획은 새 거래에 사용할 수 없습니다. Nile 계획을 다시 생성하고 확인해 주세요.","An older plan format cannot be used for a new transaction. Generate and confirm the Nile plan again."],
  ["Nile 지갑 주소를 확인할 수 없습니다. 거래를 진행하지 않습니다.","Unable to verify the Nile wallet address. The transaction will not proceed."],
  ["지갑의 기존 Nile 거래 상태가 손상되었습니다. 원 거래를 확인하기 전 재서명하지 마세요.","The wallet’s existing Nile transaction state is damaged. Do not sign again before checking the original transaction."],
  ["지갑의 저장된 Nile 거래 기록이 손상되었습니다. 원 거래를 확인하기 전 재서명하지 마세요.","The wallet’s saved Nile transaction records are damaged. Do not sign again before checking the original transaction."],
  ["같은 Nile 지갑의 다른 계획 또는 동작에 미확정 거래가 있습니다. 원 txID를 확인하고 확정될 때까지 새 거래를 서명하지 마세요.","Another plan or action for this Nile wallet has an unconfirmed transaction. Check the original txID and do not sign a new transaction until confirmation."],
  ["같은 Nile 지갑의 다른 미확정 거래가 있습니다. 원 txID를 먼저 확인해 주세요.","This Nile wallet has another unconfirmed transaction. Check the original txID first."],
  ["이 브라우저는 탭 간 거래 잠금을 지원하지 않습니다. 안전한 거래 실행을 위해 지원 브라우저를 사용해 주세요.","This browser does not support cross-tab transaction locks. Use a supported browser to execute transactions safely."],
  ["다른 탭에서 같은 Nile 지갑의 거래가 진행 중입니다. 해당 탭과 원 txID를 확인해 주세요.","A transaction for the same Nile wallet is in progress in another tab. Check that tab and the original txID."],
  ["저장된 거래 기록과 새 기록의 대상이 다릅니다.","The saved and new transaction records refer to different targets."],
  ["같은 거래 기록에 서로 다른 txID가 있습니다. 원 거래를 확인해 주세요.","The same transaction record contains different txIDs. Check the original transaction."],
  ["원 txID별 저장 기록이 손상되었습니다. 새 서명 전에 거래 상태를 확인해 주세요.","The saved original txID records are damaged. Check transaction status before signing again."],
  ["브라우저 저장소가 필요합니다.","Browser storage is required."],
  ["거래 조건이 바뀌었습니다. 새 미리보기를 확인해 주세요.","Transaction terms have changed. Check a new preview."],
  ["저장된 거래 기록이 손상되었습니다. 새 서명 전에 원 거래 상태를 확인해 주세요.","The saved transaction record is damaged. Check the original transaction status before signing again."],
  ["예치 복구 대상이 아닌 서버 거래 의도입니다.","This server transaction intent is not a deposit recovery target."],
  ["로컬 예치 기록과 서버 미해결 의도가 다릅니다. 새 서명을 진행하지 마세요.","The local deposit record and unresolved server intent do not match. Do not sign a new transaction."],
  ["서명 전 서버 예약에 다른 원 txID가 연결되어 있습니다.","A different original txID is linked to the server reservation before signing."],
  ["서명된 거래 의도는 취소할 수 없습니다. 원 txID를 확인해 주세요.","A signed transaction intent cannot be cancelled. Check the original txID."],
  ["다른 원 거래가 이미 저장되었습니다. 새 서명 전에 원 txID를 확인해 주세요.","A different original transaction is already saved. Check the original txID before signing again."],
  ["Nile jTRX 거래 미리보기 검증에 실패했습니다.","Nile jTRX transaction preview validation failed."],
  ["거래 미리보기가 만료되었습니다. 다시 확인해 주세요.","The transaction preview has expired. Check it again."],
  ["미서명 거래를 확인할 수 없습니다.","Unable to verify the unsigned transaction."],
  ["미서명 거래 ID가 올바르지 않습니다.","The unsigned transaction ID is invalid."],
  ["거래의 계약 호출 또는 수수료 상한이 미리보기와 다릅니다.","The transaction contract call or fee cap does not match the preview."],
  ["구성된 거래의 계정·계약·금액·메서드가 미리보기와 다릅니다.","The built transaction account, contract, amount, or method does not match the preview."],
  ["미서명 거래의 유효 시간이 지났습니다.","The unsigned transaction has expired."],
  ["사용자님이 확인한 미리보기 ID와 거래 대상이 다릅니다.","The confirmed preview ID does not match the transaction target."],
  ["같은 계획의 원 거래가 진행 중이거나 확정되었습니다. 원 txID를 먼저 조회해 주세요.","The original transaction for this plan is in progress or confirmed. Check the original txID first."],
  ["예치 전 같은 Nile 포지션 관측을 확인할 수 없습니다.","Unable to verify an observation of the same Nile position before depositing."],
  ["예치 전 관측을 저장할 경로가 없습니다.","No storage path is available for the pre-deposit observation."],
  ["TronWeb 안전 정수 범위를 초과했습니다.","The amount exceeds TronWeb’s safe integer range."],
  ["Nile 예치 거래 구성에 실패했습니다.","Failed to build the Nile deposit transaction."],
  ["TronLink 서명 결과가 원 거래와 다릅니다.","The TronLink signature result differs from the original transaction."],
  ["서명 전 서버 거래 예약을 확인할 수 없습니다.","Unable to verify the server transaction reservation before signing."],
  ["서버 원장의 원 거래 ID와 TronLink 서명 결과가 다릅니다.","The original transaction ID in the server ledger does not match the TronLink signature result."],
  ["서명 전 거래 예약의 취소를 확인할 수 없습니다. 서버 원장을 확인하기 전 새 거래를 만들지 마세요.","Unable to verify cancellation of the transaction reservation before signing. Do not create a new transaction before checking the server ledger."],
  ["조회할 Nile 원 거래 ID가 없습니다.","No original Nile transaction ID is available to check."],
  ["이 거래 상태에서는 영수증을 조회할 수 없습니다.","A receipt cannot be fetched in this transaction state."],
  ["조회 결과의 원 거래 ID가 다릅니다.","The original transaction ID in the fetched result does not match."],
  ["서버 원장 연결이 없어 이 거래를 확정할 수 없습니다.","This transaction cannot be confirmed without a server ledger connection."],
  ["원 txID의 서버 원장과 Nile 영수증 상태가 다릅니다. 다시 조회해 주세요.","The server ledger and Nile receipt statuses for the original txID differ. Check again."],
  ["저장된 원 거래 ID와 조회 대상이 다릅니다.","The saved original transaction ID does not match the lookup target."],
  ["확정된 거래 결과와 재조회 결과가 다릅니다. 원 txID의 영수증을 확인해 주세요.","The confirmed transaction result differs from the refreshed result. Check the receipt for the original txID."],
  ["같은 Nile 계획과 지갑의 실제 포지션 관측이 아닙니다.","This is not a live position observation for the same Nile plan and wallet."],
  ["환매 조건이 바뀌었습니다. 새 미리보기를 확인해 주세요.","Redemption terms have changed. Check a new preview."],
  ["저장된 환매 기록이 손상되었습니다. 원 거래를 확인하기 전 재서명하지 마세요.","The saved redemption record is damaged. Do not sign again before checking the original transaction."],
  ["저장된 환매 미리보기가 손상되었습니다. 원 거래를 확인할 때까지 재서명하지 마세요.","The saved redemption preview is damaged. Do not sign again until the original transaction is checked."],
  ["환매 복구 대상이 아닌 서버 거래 의도입니다.","This server transaction intent is not a redemption recovery target."],
  ["저장된 환매 미리보기와 서버 거래 의도가 다릅니다. 새 서명을 진행하지 마세요.","The saved redemption preview and server transaction intent do not match. Do not sign a new transaction."],
  ["로컬 환매 기록과 서버 미해결 의도가 다릅니다. 새 서명을 진행하지 마세요.","The local redemption record and unresolved server intent do not match. Do not sign a new transaction."],
  ["서명 전 환매 예약에 다른 원 txID가 연결되어 있습니다.","A different original txID is linked to the redemption reservation before signing."],
  ["다른 로컬 환매가 미해결 상태입니다. 원 txID를 확인해 주세요.","Another local redemption is unresolved. Check the original txID."],
  ["서명된 환매 의도는 취소할 수 없습니다. 원 txID를 확인해 주세요.","A signed redemption intent cannot be cancelled. Check the original txID."],
  ["Nile jTRX 환매 미리보기 검증에 실패했습니다.","Nile jTRX redemption preview validation failed."],
  ["환매 미리보기가 만료되었습니다. 다시 확인해 주세요.","The redemption preview has expired. Check it again."],
  ["환매 미서명 거래를 확인할 수 없습니다.","Unable to verify the unsigned redemption transaction."],
  ["환매 거래 ID가 올바르지 않습니다.","The redemption transaction ID is invalid."],
  ["환매 거래의 호출 또는 수수료 상한이 미리보기와 다릅니다.","The redemption call or fee cap does not match the preview."],
  ["환매 거래의 계정·계약·jTRX 수량·메서드가 미리보기와 다릅니다.","The redemption account, contract, jTRX amount, or method does not match the preview."],
  ["환매 미서명 거래가 만료되었습니다.","The unsigned redemption transaction has expired."],
  ["같은 Nile 계획·지갑의 확정 예치 기록이 필요합니다.","A confirmed deposit record for the same Nile plan and wallet is required."],
  ["사용자님이 확인한 환매 미리보기 ID와 거래 대상이 다릅니다.","The confirmed redemption preview ID does not match the transaction target."],
  ["이 포지션의 환매 거래가 진행 중이거나 확정되었습니다. 원 txID를 먼저 확인해 주세요.","A redemption for this position is in progress or confirmed. Check the original txID first."],
  ["TronWeb 수수료 상한의 안전 정수 범위를 초과했습니다.","The fee cap exceeds TronWeb’s safe integer range."],
  ["Nile 환매 거래 구성에 실패했습니다.","Failed to build the Nile redemption transaction."],
  ["TronLink 환매 서명 결과가 원 거래와 다릅니다.","The TronLink redemption signature result differs from the original transaction."],
  ["환매 서명 전 서버 거래 예약을 확인할 수 없습니다.","Unable to verify the server transaction reservation before redemption signing."],
  ["서버 원장의 환매 원 거래 ID와 TronLink 서명 결과가 다릅니다.","The original redemption transaction ID in the server ledger does not match the TronLink signature result."],
  ["서명 전 환매 예약의 취소를 확인할 수 없습니다. 서버 원장을 확인하기 전 새 거래를 만들지 마세요.","Unable to verify cancellation of the redemption reservation before signing. Do not create a new transaction before checking the server ledger."],
  ["같은 환매 미리보기의 Nile 원 거래 ID가 필요합니다.","The original Nile transaction ID for the same redemption preview is required."],
  ["환매 조회 결과의 원 거래 ID가 다릅니다.","The original transaction ID in the redemption result does not match."],
  ["서버 원장 연결이 없어 환매 거래를 확정할 수 없습니다.","The redemption cannot be confirmed without a server ledger connection."],
  ["원 환매 txID의 서버 원장과 Nile 영수증 상태가 다릅니다. 다시 조회해 주세요.","The server ledger and Nile receipt statuses for the original redemption txID differ. Check again."],
  ["저장된 원 환매 거래와 조회 대상이 다릅니다.","The saved original redemption does not match the lookup target."],
  ["확정된 환매 결과와 재조회 결과가 다릅니다.","The confirmed redemption result differs from the refreshed result."],
  ["같은 Nile 포지션에서 jTRX 잔고 감소를 확인하지 못했습니다.","A jTRX balance decrease in the same Nile position could not be verified."],
  ["Nile 테스트넷","Nile testnet"],
  ["Shasta 테스트넷","Shasta testnet"],
  ["네트워크 확인 필요","Verify network"],
  ["TronLink 계정 또는 네트워크가 변경되었습니다. 새 미리보기를 확인한 뒤 다시 서명해 주세요.","The TronLink account or network changed. Check a new preview before signing again."],
  ["거래 대상 지갑 주소가 올바르지 않습니다.","The transaction wallet address is invalid."],
  ["TronLink 지갑을 먼저 연결해 주세요.","Connect your TronLink wallet first."],
  ["TronLink 지갑의 계정 승인을 완료해 주세요.","Complete the account authorization in TronLink."],
  ["TronLink를 Nile 테스트넷으로 전환한 뒤 다시 확인해 주세요.","Switch TronLink to the Nile testnet and check again."],
  ["미리보기 지갑과 현재 TronLink 계정이 다릅니다.","The preview wallet does not match the current TronLink account."],
];
