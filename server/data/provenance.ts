export type Chain = 'mainnet' | 'nile';

export type DataProvenance = {
  sourceUrl: string;
  chain: Chain;
  fetchedAt: string;
  sourceUpdatedAt: string | null;
  mode: 'live';
  accessMethod: 'rest' | 'rpc' | 'mcp';
  serverId?: string;
  toolName?: string;
  serverVersion?: string;
};

export type Availability = 'ready' | 'unavailable' | 'unknown';

export class AccountReadError extends Error {
  constructor(readonly code: 'state_missing' | 'address_mismatch' | 'balance_invalid') {
    super(code);
    this.name = 'AccountReadError';
  }
}

export type DataResult<T> =
  | { status: 'ready'; value: T; source: DataProvenance }
  | { status: 'unavailable' | 'unknown'; reason: string; source: DataProvenance };

export function provenance(sourceUrl: string, chain: Chain, accessMethod: DataProvenance['accessMethod'], extra: Partial<Pick<DataProvenance, 'serverId' | 'toolName' | 'serverVersion'>> = {}): DataProvenance {
  return { sourceUrl, chain, fetchedAt: new Date().toISOString(), sourceUpdatedAt: null, mode: 'live', accessMethod, ...extra };
}

// Never print a remote body or an error's cause: either could include a credential.
export function connectionReason(error: unknown, label: string): string {
  if (error instanceof AccountReadError) {
    if (error.code === 'state_missing') return `${label} 계정 상태가 반환되지 않아 잔액을 확인하지 못했습니다.`;
    if (error.code === 'address_mismatch') return `${label} 응답 계정 주소가 요청 주소와 다릅니다.`;
    return `${label} 응답 잔액이 안전한 정수 형식이 아닙니다.`;
  }
  if (error instanceof Error && error.name === 'TimeoutError') return `${label} 응답 시간이 초과되었습니다.`;
  if (error instanceof Error && error.name === 'AbortError') return `${label} 요청이 중단되었습니다.`;
  if (error instanceof Error && /^HTTP \d{3}$/.test(error.message)) return `${label} ${error.message}`;
  const cause = error instanceof Error ? error.cause : null;
  if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOTFOUND') {
    return `${label} 호스트 DNS 조회에 실패했습니다.`;
  }
  if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ECONNREFUSED') {
    return `${label} 연결이 거부되었습니다.`;
  }
  return `${label} 연결 또는 응답 검증에 실패했습니다.`;
}
