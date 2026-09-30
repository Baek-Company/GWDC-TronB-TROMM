import { localizeKnownText, useI18n } from '../../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { TronWeb } from 'tronweb';
import { z } from 'zod';
import { toBaseUnits } from '../../../shared/markets';
import { instantSchema, sourceSchema } from '../../../shared/schemas';
import { getWalletEpoch, requireNileWallet } from '../../wallet';
import { assertSameSignedTransaction, browserNileApprovalGateway } from '../execution/approval-api';
import './nile-psm.css';

const CONTRACTS = {
  psm: 'TEwUGMSAvbmzjxWoV8JWoSqvQm1A3AXs1V',
  gemJoin: 'TBm4W3JpzsQC4z5mk96fLWZbfNKcfJ5Bxy',
  usdt: 'TZDnq7egPqzi7H4SXy1ABvwaVRvRTaVfJW',
  usdd: 'TYQF9cAeJ3Faq8QXpHxTcFco72DRCQbgFt',
} as const;
const uint = z.string().regex(/^\d+$/);
const hexId = z.string().regex(/^[0-9a-f]{64}$/i);
const stepSchema = z.enum(['approve_usdd', 'buy_gem', 'approve_usdt', 'sell_gem']);
type Step = z.infer<typeof stepSchema>;
type Direction = 'buy' | 'sell';
const balanceSchema = z.object({
  chain: z.literal('nile'), walletAddress: z.string(),
  usdtAddress: z.string(), usddAddress: z.string(),
  usdtBalanceRaw: uint, usddBalanceRaw: uint,
  usdtAllowanceToGemJoinRaw: uint, usddAllowanceToPsmRaw: uint,
  trxBalanceSun: uint, fetchedAt: instantSchema, sourceUrl: z.string().min(1), source: sourceSchema,
});
type Balances = z.infer<typeof balanceSchema>;

const previewSchema = z.object({
  id: z.string().min(1), step: stepSchema, direction: z.enum(['buy', 'sell']),
  walletAddress: z.string(), contractAddress: z.string(),
  method: z.enum(['approve(address,uint256)', 'buyGem(address,uint256)', 'sellGem(address,uint256)']),
  argumentAddress: z.string(), amountBaseUnits: uint, gemAmountRaw: uint,
  feeLimitSun: uint, estimatedFeeSun: uint, maxFeeSun: uint,
  expiresAt: instantSchema, fingerprint: z.string().min(1), source: sourceSchema,
  state: balanceSchema.extend({
    psmAddress: z.string(), gemJoinAddress: z.string(),
    sellEnabled: z.boolean(), buyEnabled: z.boolean(),
    entryCapacityUsdtRaw: uint, exitCapacityUsdtRaw: uint,
    quote: z.object({ direction: z.enum(['buy_gem', 'sell_gem']), gemAmountRaw: uint,
      usddAmountRaw: uint, feeUsddRaw: uint }),
    needsApproval: z.boolean(), blockedReasons: z.array(z.string()),
  }).passthrough(),
}).passthrough();
export type NilePsmUiPreview = z.infer<typeof previewSchema>;

const intentSchema = z.object({ id: hexId, status: z.enum([
  'reserved', 'signed', 'broadcasting', 'pending', 'unknown', 'confirmed', 'failed', 'cancelled',
]), txId: hexId.nullable(), account: z.string(), action: z.string(),
  targetContract: z.string(), targetMethod: z.string(), previewId: z.string(),
  amountBaseUnits: uint, createdAt: z.string() }).passthrough();
type Intent = z.infer<typeof intentSchema>;
const lastSchema = z.object({ intentId: hexId, txId: hexId, step: stepSchema,
  gemAmountRaw: uint, status: z.enum(['submitted', 'pending', 'unknown', 'confirmed', 'failed', 'cancelled']) });
type LastTransaction = z.infer<typeof lastSchema>;
const transactionObservationSchema = z.object({ txId: hexId,
  status: z.enum(['pending', 'confirmed', 'failed', 'unknown']),
  actualFeeSun: uint.nullable(), source: sourceSchema });
type TransactionObservation = z.infer<typeof transactionObservationSchema>;

const methodFor: Record<Step, NilePsmUiPreview['method']> = {
  approve_usdd: 'approve(address,uint256)', buy_gem: 'buyGem(address,uint256)',
  approve_usdt: 'approve(address,uint256)', sell_gem: 'sellGem(address,uint256)',
};
const stepsFor: Record<Direction, readonly [Step, Step]> = {
  buy: ['approve_usdd', 'buy_gem'], sell: ['approve_usdt', 'sell_gem'],
};

function sameAddress(a: string, b: string): boolean {
  return TronWeb.isAddress(a) && TronWeb.isAddress(b) &&
    TronWeb.address.toHex(a).toLowerCase() === TronWeb.address.toHex(b).toLowerCase();
}

function formatRaw(raw: string, decimals: number): string {
  return new Decimal(raw).div(new Decimal(10).pow(decimals)).toString();
}

export function gemAmountRaw(amount: string): string {
  const raw = toBaseUnits(amount.trim(), 6);
  if (BigInt(raw) <= 0n) throw new Error('0보다 큰 USDT 수량을 입력해 주세요.');
  return raw;
}

export function verifyNilePsmUiPreview(raw: unknown, input: {
  address: string; step: Step; gemAmountRaw: string;
}): NilePsmUiPreview {
  const preview = previewSchema.parse(raw);
  const buy = input.step === 'approve_usdd' || input.step === 'buy_gem';
  const expectedContract = input.step === 'approve_usdd' ? CONTRACTS.usdd
    : input.step === 'approve_usdt' ? CONTRACTS.usdt : CONTRACTS.psm;
  const expectedArgument = input.step === 'approve_usdd' ? CONTRACTS.psm
    : input.step === 'approve_usdt' ? CONTRACTS.gemJoin : input.address;
  const expectedAmount = input.step === 'approve_usdd'
    ? preview.state.quote.usddAmountRaw : input.gemAmountRaw;
  if (!sameAddress(preview.walletAddress, input.address) || preview.step !== input.step ||
      preview.direction !== (buy ? 'buy' : 'sell') || preview.method !== methodFor[input.step] ||
      !sameAddress(preview.contractAddress, expectedContract) ||
      !sameAddress(preview.argumentAddress, expectedArgument) ||
      !sameAddress(preview.state.psmAddress, CONTRACTS.psm) ||
      !sameAddress(preview.state.gemJoinAddress, CONTRACTS.gemJoin) ||
      !sameAddress(preview.state.usdtAddress, CONTRACTS.usdt) ||
      !sameAddress(preview.state.usddAddress, CONTRACTS.usdd) ||
      preview.state.quote.direction !== (buy ? 'buy_gem' : 'sell_gem') ||
      preview.state.quote.gemAmountRaw !== input.gemAmountRaw ||
      preview.gemAmountRaw !== input.gemAmountRaw || preview.amountBaseUnits !== expectedAmount ||
      preview.state.chain !== 'nile' || preview.source.chain !== 'nile' ||
      preview.source.mode !== 'live' || preview.state.source.mode !== 'live' ||
      preview.state.blockedReasons.length > 0 ||
      BigInt(preview.feeLimitSun) <= 0n || BigInt(preview.maxFeeSun) <= 0n ||
      BigInt(preview.maxFeeSun) > BigInt(preview.state.trxBalanceSun) ||
      Date.parse(preview.expiresAt) <= Date.now()) {
    throw new Error('Nile PSM 미리보기의 지갑·토큰·수량·비용 조건을 확인할 수 없습니다.');
  }
  return preview;
}

function verifyBalance(raw: unknown, address: string): Balances {
  const balance = balanceSchema.parse(raw);
  if (!sameAddress(balance.walletAddress, address) ||
      !sameAddress(balance.usdtAddress, CONTRACTS.usdt) ||
      !sameAddress(balance.usddAddress, CONTRACTS.usdd) ||
      balance.source.chain !== 'nile' || balance.source.mode !== 'live') {
    throw new Error('Nile PSM 잔고의 지갑·토큰 출처가 다릅니다.');
  }
  return balance;
}

async function jsonRequest(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(raw);
    throw new Error(error.success ? error.data.error : `HTTP ${response.status}`);
  }
  return raw;
}

async function psmApproval(path: string, body?: unknown): Promise<unknown> {
  return jsonRequest(`/api/approval/psm/${path}`, body);
}

function intentReply(raw: unknown): Intent {
  return intentSchema.parse(z.object({ intent: z.unknown() }).parse(raw).intent);
}

export function checkBuiltPsmTransaction(raw: unknown, preview: NilePsmUiPreview): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PSM 미서명 거래가 없습니다.');
  const tx = raw as Record<string, unknown>;
  const data = tx.raw_data as Record<string, unknown> | undefined;
  const contracts = data?.contract;
  const call = Array.isArray(contracts) ? contracts[0] as Record<string, unknown> : null;
  const value = (call?.parameter as Record<string, unknown> | undefined)?.value as Record<string, unknown> | undefined;
  const selector = TronWeb.sha3(preview.method).replace(/^0x/, '').slice(0, 8).toLowerCase();
  const abiAddress = TronWeb.address.toHex(preview.argumentAddress).slice(2).padStart(64, '0').toLowerCase();
  const abiAmount = BigInt(preview.amountBaseUnits).toString(16).padStart(64, '0').toLowerCase();
  const expectedData = selector + abiAddress + abiAmount;
  const noValue = (item: unknown) => item === undefined || item === 0 || item === '0';
  if (typeof tx.txID !== 'string' || !/^[0-9a-f]{64}$/i.test(tx.txID) ||
      typeof tx.raw_data_hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(tx.raw_data_hex) ||
      !data || !Array.isArray(contracts) || contracts.length !== 1 ||
      data.fee_limit !== Number(preview.feeLimitSun) ||
      typeof data.expiration !== 'number' || data.expiration <= Date.now() ||
      call?.type !== 'TriggerSmartContract' || !value ||
      !sameAddress(String(value.owner_address), preview.walletAddress) ||
      !sameAddress(String(value.contract_address), preview.contractAddress) ||
      String(value.data).replace(/^0x/, '').toLowerCase() !== expectedData ||
      !noValue(value.call_value) || !noValue(value.call_token_value) || !noValue(value.token_id)) {
    throw new Error('PSM 미서명 거래의 지갑·계약·함수·인자·수수료가 확인한 미리보기와 다릅니다.');
  }
}

function storageKey(address: string): string { return `gwdc:nile-psm:last:v1:${address}`; }
function readLast(address: string): LastTransaction | null {
  const saved = localStorage.getItem(storageKey(address));
  return saved === null ? null : lastSchema.parse(JSON.parse(saved) as unknown);
}
function saveLast(address: string, value: LastTransaction): void {
  localStorage.setItem(storageKey(address), JSON.stringify(lastSchema.parse(value)));
}

function previewSame(a: NilePsmUiPreview, b: NilePsmUiPreview): boolean {
  return a.fingerprint === b.fingerprint && a.step === b.step &&
    a.amountBaseUnits === b.amountBaseUnits && a.gemAmountRaw === b.gemAmountRaw &&
    a.feeLimitSun === b.feeLimitSun && a.maxFeeSun === b.maxFeeSun &&
    sameAddress(a.walletAddress, b.walletAddress);
}

export function NilePsmPanel({ address, networkKey }: { address: string; networkKey: string }) {
  const { t, locale } = useI18n();
  const LABELS: Record<Step, string> = {
    approve_usdd: t('USDD 사용 승인', "Approve USDD spending"), buy_gem: t('USDD → USDT 전환', "Swap USDD → USDT"),
    approve_usdt: t('USDT 사용 승인', "Approve USDT spending"), sell_gem: t('USDT → USDD 전환', "Swap USDT → USDD"),
  };

  const [direction, setDirection] = useState<Direction>('buy');
  const [step, setStep] = useState<Step>('approve_usdd');
  const [amount, setAmount] = useState('1');
  const [balances, setBalances] = useState<Balances | null>(null);
  const [preview, setPreview] = useState<NilePsmUiPreview | null>(null);
  const [previewEpoch, setPreviewEpoch] = useState<number | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [intents, setIntents] = useState<Intent[]>([]);
  const [last, setLast] = useState<LastTransaction | null>(null);
  const [outcome, setOutcome] = useState<TransactionObservation | null>(null);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const context = `${address}|${networkKey}|${direction}|${step}|${amount}|${getWalletEpoch()}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const ready = !!address && networkKey === 'nile';

  const clearPreview = () => { generation.current += 1; setPreview(null); setPreviewEpoch(null); setAcknowledged(false); };
  useEffect(() => {
    clearPreview(); setBalances(null); setIntents([]); setOutcome(null); setMessage('');
    setLast(null); setStorageBlocked(false);
    if (!ready) return;
    try { setLast(readLast(address)); }
    catch {
      setStorageBlocked(true);
      setMessage('저장된 PSM 거래 기록이 손상되었습니다. 원 txID 확인 전 새 거래를 진행하지 마세요.');
    }
    let active = true;
    void jsonRequest(`/api/nile/psm/balance?${new URLSearchParams({ address })}`)
      .then(raw => { if (active) setBalances(verifyBalance(raw, address)); })
      .catch(error => { if (active) setMessage(error instanceof Error ? error.message : 'Nile PSM 잔고 조회 실패'); });
    return () => { active = false; generation.current += 1; };
  // The panel's account or network changed; all previous trade terms are stale.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, networkKey]);
  useEffect(() => { clearPreview();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  const reloadBalances = async () => {
    if (!ready) return;
    setBusy(true); setMessage(''); clearPreview();
    try { setBalances(verifyBalance(await jsonRequest(`/api/nile/psm/balance?${new URLSearchParams({ address })}`), address)); }
    catch (error) { setBalances(null); setMessage(error instanceof Error ? error.message : '잔고 조회 실패'); }
    finally { setBusy(false); }
  };
  const loadUnresolved = async () => {
    if (!ready) return [];
    await browserNileApprovalGateway.authenticate(address);
    const raw = await psmApproval('unresolved');
    const found = z.object({ intents: z.array(z.unknown()) }).parse(raw).intents.map(intentReplyItem => intentSchema.parse(intentReplyItem));
    if (found.some(intent => !sameAddress(intent.account, address))) throw new Error('다른 지갑의 PSM 거래 의도가 반환되었습니다.');
    setIntents(found);
    return found;
  };
  const checkUnresolved = async () => {
    setBusy(true); setMessage('');
    try { const found = await loadUnresolved(); setMessage(found.length ? `미해결 거래 ${found.length}건이 있습니다. 원 txID를 확인해 주세요.` : '이 지갑의 미해결 PSM 거래가 없습니다.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '미해결 거래 조회 실패'); }
    finally { setBusy(false); }
  };
  const requestPreview = async () => {
    if (!ready || !balances) return;
    const requestedContext = context;
    const requestedEpoch = getWalletEpoch();
    const ticket = ++generation.current;
    setBusy(true); setMessage(''); setPreview(null); setAcknowledged(false);
    try {
      const raw = gemAmountRaw(amount);
      const result = verifyNilePsmUiPreview(await jsonRequest('/api/nile/psm/preview', {
        address, step, gemAmountRaw: raw,
      }), { address, step, gemAmountRaw: raw });
      if (ticket !== generation.current || requestedContext !== contextRef.current ||
          requestedEpoch !== getWalletEpoch()) return;
      setPreview(result); setPreviewEpoch(requestedEpoch);
    } catch (error) {
      if (ticket === generation.current) setMessage(error instanceof Error ? error.message : 'PSM 미리보기 실패');
    } finally { if (ticket === generation.current) setBusy(false); }
  };

  const execute = async () => {
    if (!ready || !preview || !acknowledged || previewEpoch !== getWalletEpoch() || busy ||
        intents.length || storageBlocked) return;
    const original = verifyNilePsmUiPreview(preview, { address, step, gemAmountRaw: gemAmountRaw(amount) });
    const fee = formatRaw(original.maxFeeSun, 6);
    if (!window.confirm(t(`Nile 시험망에서 ${LABELS[step]} 거래를 서명하시겠습니까?\n`, `Sign the ${LABELS[step]} transaction on the Nile testnet?\n`) +
      t(`계약: ${original.contractAddress}\n호출 수량: ${original.amountBaseUnits}\n최대 비용 예산: ${fee} TRX\n`, `Contract: ${original.contractAddress}\nCall amount: ${original.amountBaseUnits}\nMaximum fee budget: ${fee} TRX\n`) +
      t('이 단계만 서명하며 다음 단계는 별도로 확인합니다.', "Only this step is signed. The next step requires a separate confirmation."))) return;
    setBusy(true); setMessage('');
    let intentId: string | null = null;
    let signedTxId: string | null = null;
    try {
      const locks = navigator.locks;
      if (!locks?.request) throw new Error('탭 간 Nile 거래 잠금을 지원하는 브라우저가 필요합니다.');
      await locks.request(`gwdc:nile:wallet:${address}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new Error('다른 탭에서 이 Nile 지갑의 거래가 진행 중입니다.');
        requireNileWallet(address);
        if (previewEpoch !== getWalletEpoch()) throw new Error('지갑 상태가 바뀌었습니다. 새 미리보기를 확인해 주세요.');
        const fresh = verifyNilePsmUiPreview(await jsonRequest('/api/nile/psm/preview', {
          address, step, gemAmountRaw: original.gemAmountRaw,
        }), { address, step, gemAmountRaw: original.gemAmountRaw });
        if (!previewSame(original, fresh)) {
          setPreview(fresh); setPreviewEpoch(getWalletEpoch()); setAcknowledged(false);
          throw new Error('PSM 조건이 바뀌었습니다. 새 미리보기를 확인해 주세요.');
        }
        const unresolved = await loadUnresolved();
        if (unresolved.length) throw new Error('미해결 PSM 거래가 있습니다. 원 txID를 먼저 확인해 주세요.');
        const reserved = intentReply(await psmApproval('reserve', { preview: original, confirmedPreviewId: original.id }));
        if (reserved.status !== 'reserved' || !sameAddress(reserved.account, address)) {
          throw new Error('PSM 서명 전 서버 예약을 확인할 수 없습니다.');
        }
        intentId = reserved.id;
        const web = requireNileWallet(address);
        if (BigInt(original.feeLimitSun) > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('PSM fee_limit가 브라우저 안전 정수를 초과했습니다.');
        }
        const built = await web.transactionBuilder.triggerSmartContract(original.contractAddress, original.method,
          { feeLimit: Number(original.feeLimitSun) }, [
            { type: 'address', value: original.argumentAddress },
            { type: 'uint256', value: original.amountBaseUnits },
          ], address);
        if (built.result.result !== true) throw new Error('PSM 미서명 거래를 만들지 못했습니다.');
        checkBuiltPsmTransaction(built.transaction, original);
        requireNileWallet(address);
        if (previewEpoch !== getWalletEpoch() || Date.parse(original.expiresAt) <= Date.now()) {
          throw new Error('지갑 또는 미리보기 상태가 바뀌었습니다.');
        }
        const signed = await web.trx.sign(built.transaction);
        if (signed.txID !== built.transaction.txID || signed.raw_data_hex !== built.transaction.raw_data_hex ||
            !Array.isArray(signed.signature) || signed.signature.length !== 1) {
          throw new Error('TronLink PSM 서명 결과가 미서명 거래와 다릅니다.');
        }
        signedTxId = signed.txID;
        if (previewEpoch !== getWalletEpoch()) {
          throw new Error('서명 중 TronLink 계정 또는 체인이 변경되었습니다. 원 거래 상태를 확인해 주세요.');
        }
        const accepted = intentReply(await psmApproval('signed', {
          intentId, preview: original, signedTransaction: signed,
        }));
        if (accepted.status !== 'signed' || accepted.txId?.toLowerCase() !== signed.txID.toLowerCase()) {
          throw new Error('PSM 원 거래 ID가 서버 원장과 다릅니다.');
        }
        const saved: LastTransaction = { intentId: intentId!, txId: signed.txID, step,
          gemAmountRaw: original.gemAmountRaw, status: 'submitted' };
        saveLast(address, saved); setLast(saved);
        requireNileWallet(address);
        if (previewEpoch !== getWalletEpoch()) {
          throw new Error('방송 전 TronLink 계정 또는 체인이 변경되었습니다. 원 txID를 확인해 주세요.');
        }
        const toBroadcast = z.object({ signedTransaction: z.record(z.string(), z.unknown()) })
          .parse(await psmApproval('begin-broadcast', { intentId, preview: original })).signedTransaction;
        assertSameSignedTransaction(signed, toBroadcast);
        requireNileWallet(address);
        let broadcastAccepted: boolean | null = null;
        try {
          const response = await web.trx.sendRawTransaction(
            toBroadcast as unknown as Parameters<typeof web.trx.sendRawTransaction>[0]);
          broadcastAccepted = response.result === true;
        } catch { broadcastAccepted = null; }
        try { await psmApproval('broadcast-result', { intentId, accepted: broadcastAccepted }); }
        catch { broadcastAccepted = null; }
        const status = broadcastAccepted === true ? 'pending' : 'unknown';
        const next = { ...saved, status } as LastTransaction;
        saveLast(address, next); setLast(next);
        setMessage(`PSM 원 txID ${signed.txID} · ${status}. 확정 영수증과 잔고를 다시 확인해 주세요.`);
        setPreview(null); setAcknowledged(false);
      });
    } catch (error) {
      let cancellationError = '';
      if (intentId && !signedTxId) {
        try { await psmApproval('cancel', { intentId }); }
        catch { cancellationError = '서명 전 예약 취소를 확인하지 못했습니다. 미해결 거래를 확인한 뒤 진행해 주세요.'; }
      }
      if (signedTxId && intentId) {
        const unknown: LastTransaction = { intentId, txId: signedTxId, step,
          gemAmountRaw: original.gemAmountRaw, status: 'unknown' };
        try { saveLast(address, unknown); setLast(unknown); } catch { /* Server ledger is authoritative. */ }
      }
      clearPreview();
      setMessage(cancellationError || (error instanceof Error ? error.message :
        'PSM 거래를 확인할 수 없습니다. 원 txID를 조회해 주세요.'));
    } finally { setBusy(false); }
  };

  const reconcile = async (intentId: string) => {
    if (!ready) return;
    setBusy(true); setMessage('');
    try {
      await browserNileApprovalGateway.authenticate(address);
      const raw = z.object({ intent: z.unknown(), observation: z.unknown().optional(), balances: z.unknown().optional() })
        .parse(await psmApproval('reconcile', { intentId }));
      const intent = intentSchema.parse(raw.intent);
      if (!sameAddress(intent.account, address)) throw new Error('조회한 PSM 원 거래의 지갑이 다릅니다.');
      const observed = raw.observation ? transactionObservationSchema.parse(raw.observation) : null;
      if (observed && intent.txId?.toLowerCase() !== observed.txId.toLowerCase()) {
        throw new Error('영수증과 서버 원장의 PSM txID가 다릅니다.');
      }
      if (observed && observed.status !== intent.status &&
          (observed.status === 'confirmed' || observed.status === 'failed')) {
        throw new Error('영수증과 서버 원장의 PSM 결과가 다릅니다.');
      }
      const freshBalances = raw.balances ? verifyBalance(raw.balances, address) :
        verifyBalance(await jsonRequest(`/api/nile/psm/balance?${new URLSearchParams({ address })}`), address);
      setBalances(freshBalances);
      setOutcome(observed);
      const found = last?.intentId === intentId ? last : readLast(address);
      if (found?.intentId === intentId && intent.txId) {
        const status = intent.status === 'confirmed' || intent.status === 'failed' ? intent.status : 'unknown';
        const next: LastTransaction = { ...found, status };
        saveLast(address, next); setLast(next);
        if (status === 'confirmed' && found.step === 'approve_usdd') setStep('buy_gem');
        if (status === 'confirmed' && found.step === 'approve_usdt') setStep('sell_gem');
      }
      setIntents(current => current.filter(item => item.id !== intentId ||
        !['confirmed', 'failed'].includes(intent.status)));
      setMessage(`PSM 원 txID ${intent.txId ?? '서명 전'} · ${intent.status}` +
        (intent.status === 'confirmed' ? ' · 확정 영수증과 같은 지갑의 잔고/승인 재조회 완료' : ''));
      clearPreview();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'PSM 거래 조회 실패'); }
    finally { setBusy(false); }
  };

  const cancel = async (intentId: string) => {
    setBusy(true); setMessage('');
    try {
      await browserNileApprovalGateway.authenticate(address);
      const cancelled = intentReply(await psmApproval('cancel', { intentId }));
      if (cancelled.status !== 'cancelled') throw new Error('서명 전 PSM 예약 취소를 확인하지 못했습니다.');
      setIntents(current => current.filter(item => item.id !== intentId));
      const saved = last ?? readLast(address);
      if (saved?.intentId === intentId) {
        const next: LastTransaction = { ...saved, status: 'cancelled' };
        saveLast(address, next); setLast(next);
      }
      setMessage('서명 전 PSM 예약이 취소되었습니다. 새 미리보기를 요청해 주세요.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'PSM 예약 취소 실패'); }
    finally { setBusy(false); }
  };

  let inputRaw: string | null = null;
  let inputError = '';
  try { inputRaw = gemAmountRaw(amount); }
  catch (error) { inputError = error instanceof Error ? error.message : 'USDT 수량을 확인해 주세요.'; }
  const activePreview = preview && previewEpoch === getWalletEpoch() && ready &&
    preview.step === step && preview.gemAmountRaw === inputRaw &&
    sameAddress(preview.walletAddress, address) && Date.parse(preview.expiresAt) > Date.now()
    ? preview : null;
  const sourceBalance = direction === 'buy' ? balances?.usddBalanceRaw : balances?.usdtBalanceRaw;
  const missingSourceBalance = sourceBalance !== undefined && BigInt(sourceBalance) === 0n;

  return <section className="nile-psm-panel" aria-labelledby="nile-psm-title">
    <div className="section-intro"><div><p className="overline">NILE / PSM TEST</p>
      <h2 id="nile-psm-title">{t("Nile USDD↔USDT 단독 전환", "Standalone Nile USDD↔USDT swap")}</h2>
      <p>{t("PSM 시험 전환입니다. 이 USDD는 Nile jUSDD의 기초자산과 달라 예치 경로로 연결하지 않습니다.", "This is a PSM test swap. This USDD differs from the underlying asset of Nile jUSDD, so it is not connected to a deposit route.")}</p>
    </div><span className="section-badge amber">{t("테스트넷 · 수익 상품 아님", "Testnet · Not a yield product")}</span></div>
    <div className="surface nile-psm-surface">
      <p>{t("시험 지갑: ", "Test wallet: ")}{address || t('연결 전', "Not connected")} · {networkKey === 'nile' ? 'Nile' : t('Nile 전환 필요', "Switch to Nile")}</p>
      {!ready && <p className="market-state">{t("같은 지갑을 TronLink Nile 테스트넷에 연결해 주세요.", "Connect the same wallet to the Nile testnet in TronLink.")}</p>}
      {ready && <><div className="nile-psm-balances">
        <div><span>{t("PSM USDD 잔고", "PSM USDD balance")}</span><strong>{balances ? formatRaw(balances.usddBalanceRaw, 18) : t('조회 전', "Not fetched")} USDD</strong></div>
        <div><span>{t("PSM USDT 잔고", "PSM USDT balance")}</span><strong>{balances ? formatRaw(balances.usdtBalanceRaw, 6) : t('조회 전', "Not fetched")} USDT</strong></div>
        <div><span>{t("수수료 재원", "Fee funds")}</span><strong>{balances ? formatRaw(balances.trxBalanceSun, 6) : t('조회 전', "Not fetched")} TRX</strong></div>
      </div>
      {balances && <p className="nile-psm-source">{t("계약 USDD ", "USDD contract ")}{balances.usddAddress} · USDT {balances.usdtAddress}<br />{t("Nile RPC 조회 ", "Nile RPC fetched ")}{new Date(balances.fetchedAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' })}</p>}
      <p className="nile-psm-source">{t("이 화면은 위 PSM 계약의 토큰 잔고만 사용합니다. 같은 USDD 이름을 표시하는 다른 Nile 토큰은 전환 잔고에 포함하지 않습니다.", "This screen uses only token balances for the PSM contracts above. Other Nile tokens also named USDD are excluded from the swap balance.")}</p>
      <div className="nile-psm-actions">
        <button type="button" className="refresh-button" disabled={busy} onClick={() => void reloadBalances()}>{t("잔고 다시 조회", "Refresh balances")}</button>
        <button type="button" className="refresh-button" disabled={busy} onClick={() => void checkUnresolved()}>{t("미해결 거래 확인·복구", "Check and recover unresolved transactions")}</button>
      </div>
      <fieldset className="nile-psm-directions"><legend>{t("전환 방향", "Swap direction")}</legend>
        <label><input type="radio" name="psm-direction" checked={direction === 'buy'} onChange={() => { setDirection('buy'); setStep('approve_usdd'); clearPreview(); }} /> USDD → USDT</label>
        <label><input type="radio" name="psm-direction" checked={direction === 'sell'} onChange={() => { setDirection('sell'); setStep('approve_usdt'); clearPreview(); }} /> USDT → USDD</label>
      </fieldset>
      <label className="nile-psm-amount">{t("전환할 USDT 수량 ", "USDT amount to swap ")}<input value={amount} inputMode="decimal"
        onChange={event => { setAmount(event.target.value); clearPreview(); }} /> USDT</label>
      <small>{direction === 'buy' ? t('USDD로 지불하고 입력한 USDT를 받습니다.', "Pay with USDD and receive the entered USDT amount.") : t('입력한 USDT를 지불하고 USDD를 받습니다.', "Pay the entered USDT amount and receive USDD.")}{t(" 각 승인과 전환은 별도 거래입니다.", " Each approval and swap is a separate transaction.")}</small>
      {inputError && <p className="input-error" role="alert">{localizeKnownText(inputError, t, psmMessages)}</p>}
      {balances && missingSourceBalance && <p className="market-state" role="status">{t("이 방향의 출발 토큰 잔고가 0입니다. 현재 전환 거래를 진행할 수 없습니다.", "The source token balance for this direction is 0. A swap cannot proceed at this time.")}</p>}
      <div className="nile-psm-steps">{stepsFor[direction].map(candidate =>
        <button type="button" key={candidate} className={candidate === step ? 'plan-select' : 'refresh-button'}
          disabled={busy} onClick={() => { setStep(candidate); clearPreview(); }}>{t(`${LABELS[candidate]} 선택`, `Select: ${LABELS[candidate]}`)}</button>)}</div>
      <button type="button" className="plan-select" disabled={busy || !balances || !!inputError || storageBlocked ||
        missingSourceBalance || intents.length > 0 ||
        !!last && ['submitted', 'pending', 'unknown'].includes(last.status)} onClick={() => void requestPreview()}>{t(`${LABELS[step]} 미리보기`, `Preview: ${LABELS[step]}`)}</button>
      {activePreview && <div className="nile-psm-preview"><h3>{LABELS[step]}{t(" · 서명 전 확인", " · Review before signing")}</h3>
        {step === 'approve_usdd' && <p>{t("이번 거래는 PSM 계약에 ", "This transaction only approves the PSM contract to spend ")}{formatRaw(activePreview.amountBaseUnits, 18)}{t(" USDD 사용만 승인합니다. 전환은 별도 거래입니다.", " USDD. The swap is a separate transaction.")}</p>}
        {step === 'approve_usdt' && <p>{t("이번 거래는 GemJoin 계약에 ", "This transaction only approves the GemJoin contract to spend ")}{formatRaw(activePreview.amountBaseUnits, 6)}{t(" USDT 사용만 승인합니다. 전환은 별도 거래입니다.", " USDT. The swap is a separate transaction.")}</p>}
        {step === 'buy_gem' && <p>{formatRaw(activePreview.state.quote.usddAmountRaw, 18)}{t(" USDD를 지불하고 ", " USDD to receive ")}{formatRaw(activePreview.gemAmountRaw, 6)}{t(" USDT를 받는 현재 견적입니다.", " USDT at the current quote.")}</p>}
        {step === 'sell_gem' && <p>{formatRaw(activePreview.gemAmountRaw, 6)}{t(" USDT를 지불하고 ", " USDT to receive ")}{formatRaw(activePreview.state.quote.usddAmountRaw, 18)}{t(" USDD를 받는 현재 견적입니다.", " USDD at the current quote.")}</p>}
        <p>{t("PSM 전환 수수료 ", "PSM swap fee ")}{formatRaw(activePreview.state.quote.feeUsddRaw, 18)}{t(" USDD · 승인 거래에는 전환이 포함되지 않습니다.", " USDD · Approval transactions do not include a swap.")}</p>
        <p>{t("호출 계약 ", "Contract called ")}{activePreview.contractAddress} · {activePreview.method}</p>
        <p>{t("인자 주소 ", "Argument address ")}{activePreview.argumentAddress}{t(" · 원시 수량 ", " · Raw amount ")}{activePreview.amountBaseUnits}</p>
        <p>{t("가용 자원 미차감 비용 추정 ", "Fee estimate before available resources ")}{formatRaw(activePreview.estimatedFeeSun, 6)}{t(" TRX · 사전 비용 예산 ", " TRX · Fee budget before signing ")}{formatRaw(activePreview.maxFeeSun, 6)} TRX
          {' '}(Energy fee_limit {formatRaw(activePreview.feeLimitSun, 6)} TRX)</p>
        <p>{t("만료 ", "Expires ")}{new Date(activePreview.expiresAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' })}</p>
        <label className="usdd-risk"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />{t("이 단계의 토큰·승인 대상·전환 금액·수수료 예산을 확인했습니다. 다음 단계는 별도 확인합니다.", "I have checked the token, approval target, swap amount, and fee budget for this step. The next step requires a separate confirmation.")}</label>
        <button type="button" className="plan-select" disabled={!acknowledged || busy || intents.length > 0 || storageBlocked}
          onClick={() => void execute()}>{t("이 단계 TronLink 서명 요청", "Request TronLink signature for this step")}</button>
      </div>}
      {intents.map(intent => <div className="nile-psm-intent" key={intent.id}>
        <p>{t("서버 미해결 거래 ", "Unresolved server transaction ")}{intent.status} · {intent.targetMethod}{t(" · 원 txID ", " · Original txID ")}{intent.txId ?? t('서명 전 예약', "Reservation before signing")}</p>
        {intent.status === 'reserved' ? <button type="button" className="refresh-button" disabled={busy}
          onClick={() => void cancel(intent.id)}>{t("서명 전 예약 취소", "Cancel reservation before signing")}</button> :
          <button type="button" className="refresh-button" disabled={busy || !intent.txId}
            onClick={() => void reconcile(intent.id)}>{t("원 txID 다시 조회", "Refresh original txID")}</button>}
      </div>)}
      {last && <div className="nile-psm-intent"><p>{t("최근 PSM 거래: ", "Latest PSM transaction: ")}{LABELS[last.step]} · {last.status}{t(" · 원 txID ", " · Original txID ")}{last.txId}</p>
        <button type="button" className="refresh-button" disabled={busy}
          onClick={() => void reconcile(last.intentId)}>{t("확정 영수증과 잔고 다시 조회", "Refresh confirmed receipt and balances")}</button></div>}
      {outcome && <p className="nile-psm-source" role="status">{t("원 txID ", "Original txID ")}{outcome.txId}{t(" · Nile 영수증 ", " · Nile receipt ")}{outcome.status}
        {outcome.status === 'confirmed' && outcome.actualFeeSun !== null
          ? t(` · 실제 수수료 ${formatRaw(outcome.actualFeeSun, 6)} TRX`, ` · Actual fee ${formatRaw(outcome.actualFeeSun, 6)} TRX`) : ''}
        {' '}{t("· 확인 시각 ", "· Checked at ")}{new Date(outcome.source.fetchedAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' })}</p>}
      {message && <p className="market-state" role="status">{localizeKnownText(message, t, psmMessages)}</p>}
      </>}
    </div>
  </section>;
}

// Keep saved diagnostics intact and translate their known text only when displayed.
const psmMessages: readonly (readonly [string, string])[] = [
  ["저장된 PSM 거래 기록이 손상되었습니다. 원 txID 확인 전 새 거래를 진행하지 마세요.","The saved PSM transaction record is damaged. Do not start a new transaction before checking the original txID."],
  ["서명 중 TronLink 계정 또는 체인이 변경되었습니다. 원 거래 상태를 확인해 주세요.","The TronLink account or chain changed during signing. Check the original transaction state."],
  ["방송 전 TronLink 계정 또는 체인이 변경되었습니다. 원 txID를 확인해 주세요.","The TronLink account or chain changed before broadcast. Check the original txID."],
  ["서명 전 예약 취소를 확인하지 못했습니다. 미해결 거래를 확인한 뒤 진행해 주세요.","Unable to verify cancellation of the reservation before signing. Check unresolved transactions before proceeding."],
  ["PSM 미서명 거래의 지갑·계약·함수·인자·수수료가 확인한 미리보기와 다릅니다.","The wallet, contract, method, arguments, or fee of the unsigned PSM transaction differs from the confirmed preview."],
  ["PSM 원 txID {0} · {1} · 확정 영수증과 같은 지갑의 잔고/승인 재조회 완료","Original PSM txID {0} · {1} · Confirmed receipt and the same wallet’s balances/allowances refreshed"],
  ["Nile PSM 미리보기의 지갑·토큰·수량·비용 조건을 확인할 수 없습니다.","Unable to verify the wallet, token, amount, or fee terms of the Nile PSM preview."],
  ["PSM 원 txID {0} · {1}. 확정 영수증과 잔고를 다시 확인해 주세요.","Original PSM txID {0} · {1}. Refresh the confirmed receipt and balances."],
  ["서명 전 PSM 예약이 취소되었습니다. 새 미리보기를 요청해 주세요.","The PSM reservation before signing was cancelled. Request a new preview."],
  ["미해결 PSM 거래가 있습니다. 원 txID를 먼저 확인해 주세요.","Unresolved PSM transactions exist. Check the original txID first."],
  ["PSM 거래를 확인할 수 없습니다. 원 txID를 조회해 주세요.","Unable to verify the PSM transaction. Check the original txID."],
  ["PSM fee_limit가 브라우저 안전 정수를 초과했습니다.","The PSM fee_limit exceeds the browser’s safe integer range."],
  ["탭 간 Nile 거래 잠금을 지원하는 브라우저가 필요합니다.","A browser that supports cross-tab Nile transaction locks is required."],
  ["TronLink PSM 서명 결과가 미서명 거래와 다릅니다.","The TronLink PSM signature result does not match the unsigned transaction."],
  ["미해결 거래 {0}건이 있습니다. 원 txID를 확인해 주세요.","{0} unresolved transaction(s) found. Check the original txID."],
  ["PSM 조건이 바뀌었습니다. 새 미리보기를 확인해 주세요.","PSM terms have changed. Check a new preview."],
  ["지갑 상태가 바뀌었습니다. 새 미리보기를 확인해 주세요.","Wallet state has changed. Check a new preview."],
  ["다른 탭에서 이 Nile 지갑의 거래가 진행 중입니다.","A transaction for this Nile wallet is in progress in another tab."],
  [" · 확정 영수증과 같은 지갑의 잔고/승인 재조회 완료"," · Confirmed receipt and the same wallet’s balances/allowances refreshed"],
  ["Nile PSM 잔고의 지갑·토큰 출처가 다릅니다.","The Nile PSM balance wallet or token source does not match."],
  ["PSM 서명 전 서버 예약을 확인할 수 없습니다.","Unable to verify the server reservation before PSM signing."],
  ["영수증과 서버 원장의 PSM txID가 다릅니다.","The PSM txID in the receipt does not match the server ledger."],
  ["서명 전 PSM 예약 취소를 확인하지 못했습니다.","Unable to verify cancellation of the PSM reservation before signing."],
  ["다른 지갑의 PSM 거래 의도가 반환되었습니다.","PSM transaction intents for a different wallet were returned."],
  ["PSM 원 거래 ID가 서버 원장과 다릅니다.","The original PSM transaction ID does not match the server ledger."],
  ["영수증과 서버 원장의 PSM 결과가 다릅니다.","The PSM result in the receipt does not match the server ledger."],
  ["0보다 큰 USDT 수량을 입력해 주세요.","Enter a USDT amount greater than 0."],
  ["이 지갑의 미해결 PSM 거래가 없습니다.","This wallet has no unresolved PSM transactions."],
  ["조회한 PSM 원 거래의 지갑이 다릅니다.","The wallet of the fetched original PSM transaction does not match."],
  ["금액과 토큰 소수 자릿수를 확인해 주세요.","Check the amount and the token’s decimal precision."],
  ["PSM 미서명 거래를 만들지 못했습니다.","Unable to build the unsigned PSM transaction."],
  ["지갑 또는 미리보기 상태가 바뀌었습니다.","The wallet or preview state has changed."],
  ["uint256 금액 범위를 초과했습니다.","The amount exceeds the uint256 range."],
  ["토큰의 소수 자릿수를 초과했습니다.","The amount exceeds the token’s decimal precision."],
  ["PSM 원 txID 서명 전 · {0}","Original PSM txID before signing · {0}"],
  ["PSM 미서명 거래가 없습니다.","The unsigned PSM transaction is missing."],
  ["Nile PSM 잔고 조회 실패","Failed to fetch Nile PSM balances"],
  ["USDT 수량을 확인해 주세요.","Check the USDT amount."],
  ["PSM 원 txID {0} · {1}","Original PSM txID {0} · {1}"],
  ["미해결 거래 조회 실패","Failed to fetch unresolved transactions"],
  ["PSM 거래 조회 실패","Failed to fetch the PSM transaction"],
  ["PSM 예약 취소 실패","Failed to cancel the PSM reservation"],
  ["PSM 미리보기 실패","PSM preview failed"],
  ["잔고 조회 실패","Failed to fetch balances"],
  ["서명 전","Before signing"],
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
