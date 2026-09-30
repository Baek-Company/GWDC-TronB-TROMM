import { connectionReason, provenance, type DataResult } from '../data/provenance';
import { callJustLendRead, inspectJustLendMcp, type McpInventory, type McpRead } from './clients';
import { inspectTronGridMcp, type TronGridMcpInventory } from './trongrid';

export const JUSTLEND_MCP_DOCS = 'https://docs.justlend.org/ai_support/mcp_server/';
export const USDD_MCP_DOCS = 'https://docs.usdd.io/ai-support/mcp-server';

export async function inspectOfficialMcp(): Promise<{ justlend: DataResult<McpInventory>; usdd: DataResult<never>; trongrid: DataResult<TronGridMcpInventory> }> {
  const trongrid = inspectTronGridMcp();
  const source = provenance(JUSTLEND_MCP_DOCS, 'mainnet', 'mcp', { serverId: '@justlend/mcp-server-justlend' });
  let justlend: DataResult<McpInventory>;
  if (!process.env.JUSTLEND_MCP_ENTRY) {
    justlend = { status: 'unavailable', reason: '앱 서버용 JustLend MCP 로컬 엔트리가 미설정입니다.', source };
  } else {
    try { justlend = { status: 'ready', value: await inspectJustLendMcp(), source }; }
    catch (error) { justlend = { status: 'unavailable', reason: connectionReason(error, 'JustLend MCP'), source }; }
  }
  // USDD MCP currently initializes ~/.agent-wallet at startup. No automatic process launch
  // is allowed in this read-only app until a side-effect-free upstream mode is verified.
  const usdd: DataResult<never> = {
    status: 'unavailable',
    reason: 'USDD MCP는 시작 시 로컬 지갑을 생성할 수 있어 앱 서버에서 자동 실행하지 않습니다. PSM은 읽기 전용 RPC로 확인합니다.',
    source: provenance(USDD_MCP_DOCS, 'mainnet', 'mcp', { serverId: '@usdd/mcp-server-usdd' }),
  };
  return { justlend, usdd, trongrid: await trongrid };
}

export async function readJustLendMcpMarket(market: 'jUSDT' | 'jUSDD' | 'jTRX', chain: 'mainnet' | 'nile'): Promise<DataResult<McpRead>> {
  const source = provenance(JUSTLEND_MCP_DOCS, chain, 'mcp', { serverId: '@justlend/mcp-server-justlend', toolName: 'get_market_data' });
  if (!process.env.JUSTLEND_MCP_ENTRY) return { status: 'unavailable', reason: '앱 서버용 JustLend MCP 로컬 엔트리가 미설정입니다.', source };
  try {
    const value = await callJustLendRead('get_market_data', { market, network: chain });
    source.serverVersion = value.serverVersion ?? undefined;
    return { status: 'ready', value, source };
  } catch (error) { return { status: 'unavailable', reason: connectionReason(error, 'JustLend MCP'), source }; }
}
