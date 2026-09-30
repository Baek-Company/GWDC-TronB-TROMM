import type { TronWeb } from 'tronweb';
import { normalizeTronAddress } from './lib/tron-address';

export const TRON_CHAIN_IDS = {
  mainnet: '0x2b6653dc', shasta: '0x94a9059e', nile: '0xcd8690dc',
} as const;
export type WalletNetwork = keyof typeof TRON_CHAIN_IDS | 'unknown';

export type WalletWeb = Pick<TronWeb, 'defaultAddress' | 'fullNode' | 'transactionBuilder' | 'trx'> & { ready?: boolean };
export type TronLinkProvider = {
  isTronLink?: boolean;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  tronWeb?: WalletWeb | false;
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
};
declare global {
  interface Window { tron?: TronLinkProvider; tronLink?: TronLinkProvider; tronWeb?: WalletWeb }
}

let eventChainId: string | null = null;
let eventDisconnected = false;
let walletEpoch = 0;

export function getWalletEpoch(): number { return walletEpoch; }

export function assertWalletEpoch(expected: number): void {
  if (walletEpoch !== expected) {
    throw new Error('TronLink 계정 또는 네트워크가 변경되었습니다. 새 미리보기를 확인한 뒤 다시 서명해 주세요.');
  }
}

function provider(): TronLinkProvider | null {
  if (typeof window === 'undefined') return null;
  if (window.tron?.isTronLink === true) return window.tron;
  if (window.tronLink) return window.tronLink;
  return null;
}

function networkFromHost(host: string): WalletNetwork {
  try {
    const url = new URL(host);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) return 'unknown';
    if (url.hostname === 'nile.trongrid.io') return 'nile';
    if (url.hostname === 'api.trongrid.io') return 'mainnet';
    if (url.hostname === 'api.shasta.trongrid.io') return 'shasta';
  } catch { /* Unrecognized custom node. */ }
  return 'unknown';
}

export function getWalletState() {
  const selected = provider();
  const web = selected?.tronWeb || (typeof window !== 'undefined' && selected === window.tronLink ? window.tronWeb : undefined);
  const candidate = web?.defaultAddress?.base58;
  const address = typeof candidate === 'string' && !eventDisconnected
    ? normalizeTronAddress(candidate) ?? '' : '';
  const hostNetwork = networkFromHost(web?.fullNode?.host ?? '');
  const chainMatches = eventChainId === null || (hostNetwork !== 'unknown' && eventChainId === TRON_CHAIN_IDS[hostNetwork]);
  const networkKey: WalletNetwork = chainMatches && !eventDisconnected ? hostNetwork : 'unknown';
  const network = networkKey === 'nile' ? 'Nile 테스트넷' : networkKey === 'shasta' ? 'Shasta 테스트넷'
    : networkKey === 'mainnet' ? 'Mainnet' : '네트워크 확인 필요';
  return { address, network, networkKey, chainId: networkKey === 'unknown' ? null : TRON_CHAIN_IDS[networkKey] };
}

export async function connectWallet() {
  const selected = provider();
  if (!selected) throw new Error('Chrome에서 TronLink를 설치한 뒤 페이지를 새로고침해 주세요.');
  const result = await selected.request({ method: selected === window.tron ? 'eth_requestAccounts' : 'tron_requestAccounts' });
  eventDisconnected = false;
  walletEpoch += 1;
  const state = getWalletState();
  if (!state.address) throw new Error('지갑 잠금 해제와 연결 승인을 완료해 주세요.');
  if (Array.isArray(result) && typeof result[0] === 'string' && result[0] !== state.address) {
    throw new Error('승인된 TronLink 계정과 현재 계정이 다릅니다.');
  }
  return state;
}

export function requireNileWallet(expectedAddress: string): WalletWeb {
  const expected = normalizeTronAddress(expectedAddress);
  if (expected === null) throw new Error('거래 대상 지갑 주소가 올바르지 않습니다.');
  const selected = provider();
  if (!selected || !selected.tronWeb) throw new Error('TronLink 지갑을 먼저 연결해 주세요.');
  if (selected.tronWeb.ready === false) throw new Error('TronLink 지갑의 계정 승인을 완료해 주세요.');
  const state = getWalletState();
  if (state.networkKey !== 'nile' || state.chainId !== TRON_CHAIN_IDS.nile) {
    throw new Error('TronLink를 Nile 테스트넷으로 전환한 뒤 다시 확인해 주세요.');
  }
  if (state.address !== expected) throw new Error('미리보기 지갑과 현재 TronLink 계정이 다릅니다.');
  return selected.tronWeb;
}

export function watchWallet(listener: () => void) {
  const selected = provider();
  const onAccounts = (value: unknown) => {
    eventDisconnected = Array.isArray(value) && value.length === 0;
    walletEpoch += 1;
    listener();
  };
  const onChain = (value: unknown) => {
    eventChainId = value && typeof value === 'object' && 'chainId' in value && typeof value.chainId === 'string'
      ? value.chainId : typeof value === 'string' ? value : null;
    walletEpoch += 1;
    listener();
  };
  const onDisconnect = () => { eventDisconnected = true; walletEpoch += 1; listener(); };
  const onConnect = (value: unknown) => { eventDisconnected = false; onChain(value); };
  selected?.on?.('accountsChanged', onAccounts);
  selected?.on?.('chainChanged', onChain);
  selected?.on?.('disconnect', onDisconnect);
  selected?.on?.('connect', onConnect);
  const legacy = (event: MessageEvent) => {
    if (event.source !== window) return;
    const action = event.data?.message?.action;
    if (action === 'disconnectWeb' || action === 'rejectWeb') eventDisconnected = true;
    if (action === 'acceptWeb' || action === 'connectWeb') eventDisconnected = false;
    if (action) { walletEpoch += 1; listener(); }
  };
  window.addEventListener('message', legacy);
  return () => {
    selected?.removeListener?.('accountsChanged', onAccounts);
    selected?.removeListener?.('chainChanged', onChain);
    selected?.removeListener?.('disconnect', onDisconnect);
    selected?.removeListener?.('connect', onConnect);
    window.removeEventListener('message', legacy);
  };
}
