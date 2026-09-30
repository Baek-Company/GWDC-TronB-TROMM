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

function formatTrx(sun: string | null | undefined): string {
  return sun === null || sun === undefined ? '미확인' :
    `${new Decimal(sun).div('1000000').toString()} TRX`;
}

export function NileWithdrawalFeePreview({ preview }: { preview: NileWithdrawalPreview }) {
  return <div className="nile-fee-preview">
    <p>현재 지갑의 가용 자원 반영 예상 소각액: <strong>{formatTrx(preview.estimatedFeeBaseUnits)}</strong></p>
    {preview.state.fullBurnFeeSun !== undefined &&
      <p>Energy·Bandwidth가 없을 때의 소각 추정액: {formatTrx(preview.state.fullBurnFeeSun)}</p>}
    <p>Energy fee_limit: {formatTrx(preview.feeLimitSun)} · Bandwidth 비용 예산: {formatTrx(preview.state.bandwidthFeeUpperBoundSun)}</p>
    <p>사전 비용 예산 합계: <strong>{formatTrx(preview.maxFeeBaseUnits)}</strong>
      {preview.state.estimatedBandwidthBytes !== undefined &&
        <> · 예상 서명 거래 크기 {preview.state.estimatedBandwidthBytes} bytes</>}</p>
    <p>이 예산은 실제 납부액이나 거래 성공을 보장하지 않습니다. 가용 자원과 체인 비용은 서명 전에 변할 수 있습니다.</p>
  </div>;
}

export function NileWithdrawalFeeComparison({ record, preview }: {
  record: ExecutionRecord; preview: NileWithdrawalPreview | null;
}) {
  if (record.action !== 'withdraw' || record.chain !== 'nile' || record.status !== 'confirmed' ||
      record.receipt === null || record.confirmedAt === null || record.actualFeeBaseUnits === null) return null;
  const samePreview = preview?.id === record.previewId && preview.planId === record.planId &&
    preview.walletAddress === record.walletAddress && preview.contractAddress === record.contractAddress;
  const estimate = samePreview ? preview.estimatedFeeBaseUnits : null;
  const delta = estimate === null ? null : BigInt(record.actualFeeBaseUnits) - BigInt(estimate);
  const deltaLabel = delta === null ? null : delta === 0n ? '0 TRX' :
    `${delta > 0n ? '+' : '−'}${formatTrx((delta > 0n ? delta : -delta).toString())}`;
  return <div className="nile-fee-comparison" role="status">
    <p>확정 영수증의 실제 환매 수수료: <strong>{formatTrx(record.actualFeeBaseUnits)}</strong></p>
    {estimate !== null && <p>서명 전 예상 소각액: {formatTrx(estimate)} · 차이(실제 − 예상): <strong>{deltaLabel}</strong></p>}
    {estimate === null && <p>같은 환매의 미리보기 추정치를 확인할 수 없어 차이는 계산하지 않았습니다.</p>}
    <p>이 차이는 이번 거래의 관측값이며 미래 환매 비용을 보장하지 않습니다.</p>
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
    <h3>Nile jTRX 환매 · 별도 확인</h3>
    <p>확정된 같은 계획의 예치 뒤에만 사용할 수 있습니다. 현재 jTRX 잔고와 시장 현금, 예상 수령 TRX와 수수료를 다시 조회합니다.</p>
    <button type="button" className="refresh-button" disabled={busy || networkKey !== 'nile' || !!storageError} onClick={() => void readPosition()}>같은 포지션 재조회</button>
    {activePosition && <><p>현재 jTRX {new Decimal(activePosition.receiptBalanceBaseUnits).div('100000000').toString()} · 현재 가치 {new Decimal(activePosition.underlyingValueBaseUnits).div('1000000').toString()} TRX</p>
      <label className="field">환매할 jTRX <input value={amount} onChange={event => { setAmount(event.target.value); invalidatePreview(); }} inputMode="decimal" /></label>
      <button type="button" className="plan-select" disabled={busy || BigInt(activePosition.receiptBalanceBaseUnits) === 0n || !!active || !!storageError || recoveryBlocked || missingRecoveryPreview} onClick={() => void requestPreview()}>환매 사전 검증</button></>}
    {activePreview && <div className="nile-preview"><h4>환매 전 최종 미리보기</h4>
      <p>jTRX {new Decimal(activePreview.amountBaseUnits).div('100000000').toString()} → 현재 환율 기준 약 {new Decimal(activePreview.expectedUnderlyingSun).div('1000000').toString()} TRX</p>
      <p>계약 {activePreview.contractAddress}</p>
      <NileWithdrawalFeePreview preview={activePreview} />
      <p>유효 시각 {new Date(activePreview.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>
      <ul>{activePreview.risks.map(risk => <li key={risk}>{risk}</li>)}</ul>
      <label className="usdd-risk"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />환매 수량·계약·수령 추정·비용 예산·위험을 확인했습니다.</label>
      <button type="button" className="plan-select" disabled={!acknowledged || busy || recoveryBlocked || missingRecoveryPreview} onClick={() => void execute()}>환매 TronLink 서명 요청</button>
    </div>}
    {record && <p className="nile-withdrawal-record">원 환매 기록: {record.status} · {tentativeWithdrawalId
      ? record.status === 'rejected' ? '취소된 미방송 서명 ID ' : '서버 접수 미확인 서명 ID ' : ''}<code>{record.txId ?? '서명 전'}</code>{record.txId && !tentativeWithdrawalId && <button type="button" className="refresh-button" disabled={busy} onClick={() => void refresh()}>원 txID 다시 조회</button>}</p>}
    {record && <NileWithdrawalFeeComparison record={record} preview={savedPreview} />}
    {missingRecoveryPreview && <p className="market-state" role="status">원 환매 미리보기가 없어 원 txID만 조회할 수 있습니다. 새 환매 서명은 중단됩니다.</p>}
    {storageError && <p className="market-state error" role="alert">{storageError}</p>}
    {message && <p className="market-state" role="status">{message}</p>}
  </div>;
}
