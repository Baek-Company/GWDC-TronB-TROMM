import { localizeKnownText, useI18n } from '../../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { toBaseUnits } from '../../../shared/markets';
import { actionPreviewSchema, observationSchema, type ExecutionRecord, type Observation, type Plan,
  type PositionFlow } from '../../../shared/schemas';
import type { NileTransactionResult, NileWithdrawalPreview } from '../../../server/transactions';
import { confirmedNileWithdrawalFlow } from '../../lib/review-evidence';
import { browserNileApprovalGateway } from './approval-api';
import { executeNileWithdrawal, getNileWithdrawalPreview, getNileWithdrawalRecord,
  refreshNileWithdrawalRecord, WithdrawalPreviewChangedError } from './withdraw';
import { matchesNileWithdrawalPreview } from './preview-context';
import { getWalletEpoch } from '../../wallet';

export const nileWithdrawalResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('deferred'), reason: z.string() }),
  z.object({ status: z.literal('ready'), preview: actionPreviewSchema.extend({
    feeLimitSun: z.string().regex(/^\d+$/), expectedUnderlyingSun: z.string().regex(/^\d+$/),
    state: z.object({ jtrxBalanceRaw: z.string().regex(/^\d+$/) }).passthrough(),
  }) }),
]);

async function requestWithdrawalPreview(plan: Plan, address: string, jtrxAmountRaw: string,
  signal?: AbortSignal): Promise<NileWithdrawalPreview> {
  const response = await fetch('/api/withdraw/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, address, jtrxAmountRaw }), signal });
  const raw: unknown = await response.json();
  if (!response.ok) throw new Error(z.object({ error: z.string() }).safeParse(raw).data?.error || `HTTP ${response.status}`);
  const result = nileWithdrawalResultSchema.parse(raw);
  if (result.status === 'deferred') throw new Error(`환매 보류: ${result.reason}`);
  if (result.preview.method !== 'redeem(uint256)' || result.preview.planId !== plan.id ||
      result.preview.walletAddress !== address) throw new Error('환매 미리보기의 계획·지갑이 일치하지 않습니다.');
  return result.preview as NileWithdrawalPreview;
}

function formatTrx(sun: string | null | undefined, unknownLabel: string): string {
  return sun === null || sun === undefined ? unknownLabel :
    `${new Decimal(sun).div('1000000').toString()} TRX`;
}

export function NileWithdrawalFeePreview({ preview }: { preview: NileWithdrawalPreview }) {
  const { t } = useI18n();
  return <div className="nile-fee-preview">
    <p>{t("현재 지갑의 가용 자원 반영 예상 소각액: ", "Estimated burn after available wallet resources: ")}<strong>{formatTrx(preview.estimatedFeeBaseUnits, t('미확인', 'Unverified'))}</strong></p>
    {preview.state.fullBurnFeeSun !== undefined &&
      <p>{t("Energy·Bandwidth가 없을 때의 소각 추정액: ", "Estimated burn with no Energy or Bandwidth: ")}{formatTrx(preview.state.fullBurnFeeSun, t('미확인', 'Unverified'))}</p>}
    <p>Energy fee_limit: {formatTrx(preview.feeLimitSun, t('미확인', 'Unverified'))}{t(" · Bandwidth 비용 예산: ", " · Bandwidth fee budget: ")}{formatTrx(preview.state.bandwidthFeeUpperBoundSun, t('미확인', 'Unverified'))}</p>
    <p>{t("사전 비용 예산 합계: ", "Total fee budget before signing: ")}<strong>{formatTrx(preview.maxFeeBaseUnits, t('미확인', 'Unverified'))}</strong>
      {preview.state.estimatedBandwidthBytes !== undefined &&
        <>{t(" · 예상 서명 거래 크기 ", " · Estimated signed transaction size ")}{preview.state.estimatedBandwidthBytes} bytes</>}</p>
    <p>{t("이 예산은 실제 납부액이나 거래 성공을 보장하지 않습니다. 가용 자원과 체인 비용은 서명 전에 변할 수 있습니다.", "This budget does not guarantee the actual fee or transaction success. Available resources and chain fees may change before signing.")}</p>
  </div>;
}

export function NileWithdrawalFeeComparison({ record, preview }: {
  record: ExecutionRecord; preview: NileWithdrawalPreview | null;
}) {
  const { t } = useI18n();
  if (record.action !== 'withdraw' || record.chain !== 'nile' || record.status !== 'confirmed' ||
      record.receipt === null || record.confirmedAt === null || record.actualFeeBaseUnits === null) return null;
  const samePreview = preview?.id === record.previewId && preview.planId === record.planId &&
    preview.walletAddress === record.walletAddress && preview.contractAddress === record.contractAddress;
  const estimate = samePreview ? preview.estimatedFeeBaseUnits : null;
  const delta = estimate === null ? null : BigInt(record.actualFeeBaseUnits) - BigInt(estimate);
  const deltaLabel = delta === null ? null : delta === 0n ? '0 TRX' :
    `${delta > 0n ? '+' : '−'}${formatTrx((delta > 0n ? delta : -delta).toString(), t('미확인', 'Unverified'))}`;
  return <div className="nile-fee-comparison" role="status">
    <p>{t("확정 영수증의 실제 환매 수수료: ", "Actual redemption fee from the confirmed receipt: ")}<strong>{formatTrx(record.actualFeeBaseUnits, t('미확인', 'Unverified'))}</strong></p>
    {estimate !== null && <p>{t("서명 전 예상 소각액: ", "Estimated burn before signing: ")}{formatTrx(estimate, t('미확인', 'Unverified'))}{t(" · 차이(실제 − 예상): ", " · Difference (actual − estimated): ")}<strong>{deltaLabel}</strong></p>}
    {estimate === null && <p>{t("같은 환매의 미리보기 추정치를 확인할 수 없어 차이는 계산하지 않았습니다.", "The matching redemption preview is unavailable, so no difference was calculated.")}</p>}
    <p>{t("이 차이는 이번 거래의 관측값이며 미래 환매 비용을 보장하지 않습니다.", "This difference is an observation from this transaction and does not guarantee future redemption fees.")}</p>
  </div>;
}

export function NileWithdrawalPanel({ plan, address, networkKey, depositRecord, recoveryBlocked, recoveryRevision,
  onRecord, onObservation,
  onWithdrawalFlow }: {
  plan: Plan; address: string; networkKey: string; depositRecord: ExecutionRecord;
  recoveryBlocked?: boolean; recoveryRevision?: number;
  onRecord: (record: ExecutionRecord) => void;
  onObservation: (observation: Observation) => void;
  onWithdrawalFlow: (flow: PositionFlow) => void;
}) {
  const { t, locale } = useI18n();
  const [amount, setAmount] = useState('');
  const [position, setPosition] = useState<Observation | null>(null);
  const [preview, setPreview] = useState<NileWithdrawalPreview | null>(null);
  const [previewEpoch, setPreviewEpoch] = useState<number | null>(null);
  const [savedPreview, setSavedPreview] = useState<NileWithdrawalPreview | null>(null);
  const [record, setRecord] = useState<ExecutionRecord | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [storageError, setStorageError] = useState('');
  const previewGeneration = useRef(0);
  const positionGeneration = useRef(0);
  const previewAbort = useRef<AbortController | null>(null);
  const positionAbort = useRef<AbortController | null>(null);
  const context = `${plan.id}|${plan.quoteVersion ?? ''}|${address}|${networkKey}|${getWalletEpoch()}|${depositRecord.id}|${depositRecord.status}|${recoveryRevision ?? 0}`;
  const contextRef = useRef(context);
  const previewContextRef = useRef(`${context}|${amount}`);
  contextRef.current = context;
  previewContextRef.current = `${context}|${amount}`;
  const invalidatePreview = () => {
    previewGeneration.current += 1;
    previewAbort.current?.abort(); previewAbort.current = null;
    setPreview(null); setPreviewEpoch(null); setAcknowledged(false);
  };

  useEffect(() => {
    positionGeneration.current += 1; positionAbort.current?.abort();
    invalidatePreview();
    setPosition(null); setAmount(''); setPreview(null); setAcknowledged(false); setMessage('');
    try {
      setRecord(getNileWithdrawalRecord(plan.id, address));
      setSavedPreview(getNileWithdrawalPreview(plan.id, address));
      setStorageError('');
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : '저장된 환매 상태를 확인할 수 없습니다.');
    }
    return () => {
      positionGeneration.current += 1; positionAbort.current?.abort();
      previewGeneration.current += 1; previewAbort.current?.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!event.key?.startsWith('gwdc:nile-withdrawal:') &&
          !event.key?.startsWith('gwdc:nile-withdrawal-preview:') &&
          !event.key?.startsWith('gwdc:nile-transaction:')) return;
      try {
        setRecord(getNileWithdrawalRecord(plan.id, address));
        setSavedPreview(getNileWithdrawalPreview(plan.id, address));
        setStorageError('');
      } catch (cause) {
        setStorageError(cause instanceof Error ? cause.message : '저장된 환매 상태를 확인할 수 없습니다.');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [plan.id, address]);

  const activePosition = position?.planId === plan.id && position.walletAddress === address &&
    position.chain === 'nile' && networkKey === 'nile' ? position : null;
  const activePreview = previewEpoch === getWalletEpoch() &&
    matchesNileWithdrawalPreview(preview, plan, address, networkKey, activePosition, amount)
    ? preview : null;
  const missingRecoveryPreview = !!record?.approvalIntentId && !!record.txId && !savedPreview &&
    record.status !== 'rejected';
  const tentativeWithdrawalId = !!record?.txId && record.submittedAt === null &&
    (record.status === 'unknown' || record.status === 'rejected');

  const readPosition = async () => {
    const generation = ++positionGeneration.current;
    const requestedContext = context;
    positionAbort.current?.abort();
    const controller = new AbortController();
    positionAbort.current = controller;
    invalidatePreview();
    setBusy(true); setMessage('');
    try {
      const params = new URLSearchParams({ planId: plan.id, address });
      const response = await fetch(`/api/observe?${params}`, { signal: controller.signal });
      const raw: unknown = await response.json();
      if (generation !== positionGeneration.current || requestedContext !== contextRef.current) return;
      if (!response.ok) throw new Error('Nile jTRX 포지션 조회에 실패했습니다.');
      const current = observationSchema.parse(raw);
      if (current.planId !== plan.id || current.walletAddress !== address || current.chain !== 'nile' ||
          current.source.mode !== 'live' || current.receiptToken.address !== plan.quote?.marketAddress) {
        throw new Error('같은 Nile 계획의 실제 jTRX 포지션이 아닙니다.');
      }
      setPosition(current);
      setAmount(new Decimal(current.receiptBalanceBaseUnits).div('100000000').toString());
      onObservation(current);
    } catch (cause) {
      if (generation === positionGeneration.current && !controller.signal.aborted) {
        setMessage(cause instanceof Error ? cause.message : '포지션 조회 실패');
      }
    } finally { if (generation === positionGeneration.current) setBusy(false); }
  };

  const requestPreview = async () => {
    if (networkKey !== 'nile' || !activePosition || storageError || recoveryBlocked || missingRecoveryPreview) return;
    const requestedWalletEpoch = getWalletEpoch();
    const generation = ++previewGeneration.current;
    const requestedContext = previewContextRef.current;
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    setBusy(true); setMessage(''); setPreview(null); setPreviewEpoch(null); setAcknowledged(false);
    try {
      const raw = toBaseUnits(amount, 8);
      if (BigInt(raw) <= 0n || BigInt(raw) > BigInt(activePosition.receiptBalanceBaseUnits)) {
        throw new Error('실제로 관측한 jTRX 잔고 이내의 수량을 입력해 주세요.');
      }
      const result = await requestWithdrawalPreview(plan, address, raw, controller.signal);
      if (generation !== previewGeneration.current || requestedContext !== previewContextRef.current ||
          requestedWalletEpoch !== getWalletEpoch()) return;
      if (!matchesNileWithdrawalPreview(result, plan, address, networkKey, activePosition, amount)) {
        throw new Error('응답의 환매 조건이 현재 입력과 다릅니다.');
      }
      setPreview(result); setPreviewEpoch(requestedWalletEpoch);
    } catch (cause) {
      if (generation === previewGeneration.current && !controller.signal.aborted) {
        setMessage(cause instanceof Error ? cause.message : '환매 미리보기 실패');
      }
    } finally { if (generation === previewGeneration.current) { setBusy(false); previewAbort.current = null; } }
  };

  const execute = async () => {
    if (!activePreview || !acknowledged || storageError || recoveryBlocked || missingRecoveryPreview) return;
    setBusy(true); setMessage('');
    try {
      const result = await executeNileWithdrawal({ preview: activePreview, depositRecord,
        t,
        expectedWalletEpoch: previewEpoch!,
        confirmPreviewId: activePreview.id,
        approval: browserNileApprovalGateway,
        refreshPreview: current => requestWithdrawalPreview(plan, address, current.amountBaseUnits),
        onRecord: current => { setRecord(current); onRecord(current); },
      });
      setRecord(result); setSavedPreview(activePreview); setPreview(null); setPreviewEpoch(null); setAcknowledged(false);
      setMessage(result.txId ? `원 환매 거래 ID: ${result.txId} · 상태: ${result.status}` : `환매 상태: ${result.status}`);
    } catch (cause) {
      if (cause instanceof WithdrawalPreviewChangedError) {
        setPreview(cause.updatedPreview); setAcknowledged(false);
      }
      setMessage(cause instanceof Error ? cause.message : '환매 요청 실패');
    } finally { setBusy(false); }
  };

  const refresh = async () => {
    if (!record?.txId || storageError) return;
    setBusy(true); setMessage('');
    try {
      const result = await refreshNileWithdrawalRecord({ record, preview: savedPreview ?? undefined,
        approval: browserNileApprovalGateway,
        readTransaction: async txId => {
          const response = await fetch(`/api/transactions/${encodeURIComponent(txId)}`);
          if (!response.ok) throw new Error('원 환매 거래 조회에 실패했습니다.');
          return await response.json() as NileTransactionResult;
        },
        readObservation: async current => {
          const params = new URLSearchParams({ planId: current.planId, address: current.walletAddress });
          const response = await fetch(`/api/observe?${params}`);
          if (!response.ok) throw new Error('환매 뒤 같은 포지션을 조회하지 못했습니다.');
          return observationSchema.parse(await response.json());
        },
        onRecord: current => { setRecord(current); onRecord(current); },
      });
      if (result.observation) {
        // The receipt was reconciled against this fresh position; display it here too.
        invalidatePreview();
        setPosition(result.observation);
        setAmount(new Decimal(result.observation.receiptBalanceBaseUnits).div('100000000').toString());
        onObservation(result.observation);
      }
      const flow = result.observation && savedPreview
        ? confirmedNileWithdrawalFlow(plan, result.record, savedPreview, result.observation) : null;
      if (flow) onWithdrawalFlow(flow);
      setMessage(`원 환매 거래: ${result.record.status}${result.observation ? ' · jTRX 잔고 감소 확인' : ''}` +
        (flow ? ` · 영수증에서 실제 수령 ${flow.amount} TRX 확인`
          : result.record.status === 'confirmed' ? ' · 실제 수령 TRX 미확인' : ''));
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '환매 상태 조회 실패'); }
    finally { setBusy(false); }
  };

  const active = record && ['awaiting_signature', 'submitted', 'pending', 'unknown'].includes(record.status);
  return <div className="surface nile-withdrawal">
    <h3>{t("Nile jTRX 환매 · 별도 확인", "Nile jTRX redemption · Separate confirmation")}</h3>
    <p>{t("확정된 같은 계획의 예치 뒤에만 사용할 수 있습니다. 현재 jTRX 잔고와 시장 현금, 예상 수령 TRX와 수수료를 다시 조회합니다.", "Available only after a confirmed deposit for the same plan. Fetches the current jTRX balance, market cash, estimated TRX received, and fees again.")}</p>
    <button type="button" className="refresh-button" disabled={busy || networkKey !== 'nile' || !!storageError} onClick={() => void readPosition()}>{t("같은 포지션 재조회", "Refresh the same position")}</button>
    {activePosition && <><p>{t("현재 jTRX ", "Current jTRX ")}{new Decimal(activePosition.receiptBalanceBaseUnits).div('100000000').toString()}{t(" · 현재 가치 ", " · Current value ")}{new Decimal(activePosition.underlyingValueBaseUnits).div('1000000').toString()} TRX</p>
      <label className="field">{t("환매할 jTRX ", "jTRX to redeem ")}<input value={amount} onChange={event => { setAmount(event.target.value); invalidatePreview(); }} inputMode="decimal" /></label>
      <button type="button" className="plan-select" disabled={busy || BigInt(activePosition.receiptBalanceBaseUnits) === 0n || !!active || !!storageError || recoveryBlocked || missingRecoveryPreview} onClick={() => void requestPreview()}>{t("환매 사전 검증", "Check redemption before signing")}</button></>}
    {activePreview && <div className="nile-preview"><h4>{t("환매 전 최종 미리보기", "Final redemption preview")}</h4>
      <p>jTRX {new Decimal(activePreview.amountBaseUnits).div('100000000').toString()}{t(" → 현재 환율 기준 약 ", " → Approximately, at the current exchange rate: ")}{new Decimal(activePreview.expectedUnderlyingSun).div('1000000').toString()} TRX</p>
      <p>{t("계약 ", "Contract ")}{activePreview.contractAddress}</p>
      <NileWithdrawalFeePreview preview={activePreview} />
      <p>{t("유효 시각 ", "Valid until ")}{new Date(activePreview.expiresAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' })}</p>
      <ul>{activePreview.risks.map(risk => <li key={risk}>{localizeKnownText(risk, t, withdrawalMessages)}</li>)}</ul>
      <label className="usdd-risk"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />{t("환매 수량·계약·수령 추정·비용 예산·위험을 확인했습니다.", "I have checked the redemption amount, contract, estimated proceeds, fee budget, and risks.")}</label>
      <button type="button" className="plan-select" disabled={!acknowledged || busy || recoveryBlocked || missingRecoveryPreview} onClick={() => void execute()}>{t("환매 TronLink 서명 요청", "Request TronLink redemption signature")}</button>
    </div>}
    {record && <p className="nile-withdrawal-record">{t("원 환매 기록: ", "Original redemption record: ")}{record.status} · {tentativeWithdrawalId
      ? record.status === 'rejected' ? t('취소된 미방송 서명 ID ', "Cancelled unbroadcast signature ID ") : t('서버 접수 미확인 서명 ID ', "Signature ID with unverified server acceptance ") : ''}<code>{record.txId ?? t('서명 전', "Before signing")}</code>{record.txId && !tentativeWithdrawalId && <button type="button" className="refresh-button" disabled={busy} onClick={() => void refresh()}>{t("원 txID 다시 조회", "Refresh original txID")}</button>}</p>}
    {record && <NileWithdrawalFeeComparison record={record} preview={savedPreview} />}
    {missingRecoveryPreview && <p className="market-state" role="status">{t("원 환매 미리보기가 없어 원 txID만 조회할 수 있습니다. 새 환매 서명은 중단됩니다.", "The original redemption preview is unavailable. Only the original txID can be checked; new redemption signing is blocked.")}</p>}
    {storageError && <p className="market-state error" role="alert">{localizeKnownText(storageError, t, withdrawalMessages)}</p>}
    {message && <p className="market-state" role="status">{localizeKnownText(message, t, withdrawalMessages)}</p>}
  </div>;
}

// Keep saved diagnostics intact and translate their known text only when displayed.
const withdrawalMessages: readonly (readonly [string, string])[] = [
  ["예상 수수료는 현재 무료 Energy·Bandwidth를 차감한 TRX 소각 추정치입니다. 자원은 서명 전에 변할 수 있습니다.","The estimated fee is TRX burned after current free Energy and Bandwidth. Resources may change before signing."],
  ["최대 수수료는 Energy fee_limit과 Bandwidth 예산의 합이며 실제 납부액이나 거래 성공 보증이 아닙니다.","The maximum fee combines the Energy fee_limit and Bandwidth budget. It does not guarantee the actual fee or transaction success."],
  ["redeem(uint256)에는 최소 TRX 수령량 인자가 없어 실제 수령액은 환율에 따라 달라질 수 있습니다.","redeem(uint256) has no minimum TRX proceeds parameter, so the actual amount received may vary with the exchange rate."],
  ["Nile 동적 Energy 최대 계수가 확인되지 않아 현재 Energy의 2배를 상한 정책으로 사용합니다.","The Nile maximum dynamic Energy factor is unverified, so the cap policy uses twice the current Energy."],
  ["원 환매 거래: {0} · jTRX 잔고 감소 확인 · 영수증에서 실제 수령 {1} TRX 확인","Original redemption transaction: {0} · jTRX balance decrease confirmed · Receipt confirms {1} TRX received"],
  ["원 환매 거래: {0} · jTRX 잔고 감소 확인 · 실제 수령 TRX 미확인","Original redemption transaction: {0} · jTRX balance decrease confirmed · Actual TRX received is unverified"],
  ["실제로 관측한 jTRX 잔고 이내의 수량을 입력해 주세요.","Enter an amount within the observed jTRX balance."],
  ["원 환매 거래: {0} · 영수증에서 실제 수령 {1} TRX 확인","Original redemption transaction: {0} · Receipt confirms {1} TRX received"],
  ["담보로 사용 중인 jTRX는 환매가 실패할 수 있습니다.","Redemption may fail when jTRX is being used as collateral."],
  ["같은 Nile 계획의 실제 jTRX 포지션이 아닙니다.","This is not a live jTRX position for the same Nile plan."],
  ["환매 미리보기의 계획·지갑이 일치하지 않습니다.","The redemption preview does not match the plan or wallet."],
  ["Nile jTRX 포지션 조회에 실패했습니다.","Failed to fetch the Nile jTRX position."],
  ["원 환매 거래: {0} · 실제 수령 TRX 미확인","Original redemption transaction: {0} · Actual TRX received is unverified"],
  ["원 환매 거래: {0} · jTRX 잔고 감소 확인","Original redemption transaction: {0} · jTRX balance decrease confirmed"],
  ["환매 뒤 같은 포지션을 조회하지 못했습니다.","Unable to fetch the same position after redemption."],
  ["응답의 환매 조건이 현재 입력과 다릅니다.","The returned redemption terms do not match the current input."],
  ["금액과 토큰 소수 자릿수를 확인해 주세요.","Check the amount and the token’s decimal precision."],
  ["저장된 환매 상태를 확인할 수 없습니다.","Unable to verify the saved redemption state."],
  [" · 영수증에서 실제 수령 {0} TRX 확인"," · Receipt confirms {0} TRX received"],
  ["uint256 금액 범위를 초과했습니다.","The amount exceeds the uint256 range."],
  ["원 환매 거래 ID: {0} · 상태: {1}","Original redemption transaction ID: {0} · Status: {1}"],
  ["원 환매 거래 조회에 실패했습니다.","Failed to fetch the original redemption transaction."],
  ["토큰의 소수 자릿수를 초과했습니다.","The amount exceeds the token’s decimal precision."],
  [" · jTRX 잔고 감소 확인"," · jTRX balance decrease confirmed"],
  [" · 실제 수령 TRX 미확인"," · Actual TRX received is unverified"],
  ["환매 상태 조회 실패","Failed to fetch redemption status"],
  ["환매 미리보기 실패","Failed to preview redemption"],
  ["포지션 조회 실패","Failed to fetch the position"],
  ["원 환매 거래: {0}","Original redemption transaction: {0}"],
  ["환매 요청 실패","Redemption request failed"],
  ["환매 보류: {0}","Redemption deferred: {0}"],
  ["환매 상태: {0}","Redemption status: {0}"],
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
