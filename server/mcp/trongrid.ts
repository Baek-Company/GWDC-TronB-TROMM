import { connectionReason, provenance, type DataResult } from '../data/provenance';

export const TRONGRID_MCP_URL = 'https://mcp.trongrid.io/mcp';
export const TRONGRID_MCP_DOCS = 'https://developers.tron.network/docs/mcp';

// Only official TronGrid API query tools are exposed. Wallet, WalletSolidity,
// JSON-RPC, transaction construction, and broadcast tools are excluded.
export const TRONGRID_READ_TOOLS = [
  'getBlockStatistics', 'getAccountInfo', 'getTrc20Balance', 'getTrc20Info',
  'getEventsByTransactionId', 'getEventsByLatestBlock',
] as const;
export type TronGridReadTool = typeof TRONGRID_READ_TOOLS[number];
export type TronGridMcpInventory = { serverVersion: string | null; toolNames: TronGridReadTool[] };
export type TronGridMcpRead = { serverVersion: string | null; toolName: TronGridReadTool; result: unknown; outputSchemaVerified: false };

const readToolNames = new Set<string>(TRONGRID_READ_TOOLS);
const MAX_RESPONSE_BYTES = 4_000_000;
let rateLimitedUntil = 0;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MCP object');
  return value as Record<string, unknown>;
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error('MCP response body missing');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('MCP response too large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function rpcResult(messageValue: unknown, id: number): Record<string, unknown> | null {
  const message = object(messageValue);
  if (message.jsonrpc !== '2.0' || message.id !== id) return null;
  if (message.error !== undefined || message.result === undefined) throw new Error('MCP protocol result missing');
  return object(message.result);
}

async function eventStreamResult(response: Response, id: number): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('MCP event stream missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('MCP event stream too large');
      pending += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(pending);
        if (!boundary) break;
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const result = rpcResult(JSON.parse(data), id);
        if (result) return result;
      }
    }
    throw new Error('MCP event result missing');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

class TronGridSession {
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private nextId = 1;
  serverVersion: string | null = null;

  private async post(method: string, params: Record<string, unknown>, notification = false): Promise<Record<string, unknown> | null> {
    if (Date.now() < rateLimitedUntil) throw new Error('HTTP 429');
    const id = notification ? null : this.nextId++;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    };
    if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
    if (this.sessionId && this.protocolVersion) {
      headers['mcp-session-id'] = this.sessionId;
      headers['MCP-Protocol-Version'] = this.protocolVersion;
    }
    const response = await fetch(TRONGRID_MCP_URL, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 429) rateLimitedUntil = Date.now() + 30_000;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (notification) {
      if (response.status !== 202) throw new Error('MCP initialized notification was not accepted');
      return null;
    }
    const sessionId = response.headers.get('mcp-session-id');
    if (method === 'initialize') {
      if (!sessionId || !/^[\x21-\x7e]{1,256}$/.test(sessionId)) throw new Error('MCP session ID missing');
      this.sessionId = sessionId;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) return eventStreamResult(response, id!);
    if (contentType.includes('application/json')) {
      const result = rpcResult(JSON.parse(await boundedText(response)), id!);
      if (!result) throw new Error('MCP response ID missing');
      return result;
    }
    throw new Error('Unsupported MCP content type');
  }

  async initialize(): Promise<void> {
    const result = object(await this.post('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'leemir-read-api', version: '0.1.0' },
    }));
    if (typeof result.protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(result.protocolVersion)) {
      throw new Error('MCP protocol version missing');
    }
    this.protocolVersion = result.protocolVersion;
    const serverInfo = object(result.serverInfo ?? {});
    this.serverVersion = typeof serverInfo.version === 'string' ? serverInfo.version : null;
    await this.post('notifications/initialized', {}, true);
  }

  async listReadTools(): Promise<TronGridReadTool[]> {
    const toolNames = new Set<TronGridReadTool>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const result = object(await this.post('tools/list', cursor ? { cursor } : {}));
      if (!Array.isArray(result.tools)) throw new Error('MCP tools/list schema mismatch');
      for (const item of result.tools) {
        const name = object(item).name;
        if (typeof name === 'string' && readToolNames.has(name)) toolNames.add(name as TronGridReadTool);
      }
      if (result.nextCursor === undefined || result.nextCursor === null) return [...toolNames];
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === cursor) {
        throw new Error('MCP tools/list cursor invalid');
      }
      cursor = result.nextCursor;
    }
    throw new Error('MCP tools/list exceeded page limit');
  }

  async call(toolName: TronGridReadTool, args: Record<string, unknown>): Promise<unknown> {
    const result = object(await this.post('tools/call', { name: toolName, arguments: args }));
    if (result.isError === true) throw new Error('MCP read tool returned an error');
    if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
    if (Array.isArray(result.content)) {
      const text = result.content.map(item => object(item)).find(item => item.type === 'text');
      if (text && typeof text.text === 'string') return JSON.parse(text.text);
    }
    throw new Error('MCP read result missing');
  }
}

// A sources refresh asks for inventory and one read tool at the same time.
// Share that handshake so one refresh does not create two MCP sessions.
let pendingInventory: Promise<{ session: TronGridSession; toolNames: TronGridReadTool[] }> | null = null;
function readInventory() {
  if (pendingInventory) return pendingInventory;
  const pending = (async () => {
    const session = new TronGridSession();
    await session.initialize();
    return { session, toolNames: await session.listReadTools() };
  })();
  pendingInventory = pending;
  void pending.finally(() => { if (pendingInventory === pending) pendingInventory = null; }).catch(() => undefined);
  return pending;
}

function validArguments(args: Record<string, unknown>): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const entries = Object.entries(args);
  return entries.length <= 8 && entries.every(([key, value]) =>
    /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)
    && !/(?:private|secret|password|mnemonic|seed|api.?key)/i.test(key)
    && (typeof value === 'boolean'
      || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      || (typeof value === 'string' && value.length <= 128)));
}

export async function inspectTronGridMcp(): Promise<DataResult<TronGridMcpInventory>> {
  const source = provenance(TRONGRID_MCP_URL, 'mainnet', 'mcp', { serverId: 'TronGrid' });
  try {
    const { session, toolNames } = await readInventory();
    source.serverVersion = session.serverVersion ?? undefined;
    if (toolNames.length === 0) return { status: 'unknown', reason: '공식 조회 도구를 tools/list에서 확인하지 못했습니다.', source };
    return { status: 'ready', value: { serverVersion: session.serverVersion, toolNames }, source };
  } catch (error) { return { status: 'unavailable', reason: connectionReason(error, 'TronGrid MCP'), source }; }
}

export async function readTronGridMcp(toolName: TronGridReadTool, args: Record<string, unknown>): Promise<DataResult<TronGridMcpRead>> {
  const source = provenance(TRONGRID_MCP_URL, 'mainnet', 'mcp', { serverId: 'TronGrid', toolName });
  if (!readToolNames.has(toolName)) return { status: 'unavailable', reason: 'TronGrid MCP 읽기 허용 목록 밖 도구입니다.', source };
  if (!validArguments(args)) return { status: 'unavailable', reason: 'TronGrid MCP 조회 인자 형식을 확인해 주세요.', source };
  try {
    const { session, toolNames } = await readInventory();
    if (!toolNames.includes(toolName)) return { status: 'unknown', reason: '공식 MCP 응답에서 요청한 조회 도구를 확인하지 못했습니다.', source };
    const result = await session.call(toolName, args);
    source.serverVersion = session.serverVersion ?? undefined;
    return { status: 'ready', value: { serverVersion: session.serverVersion, toolName, result, outputSchemaVerified: false }, source };
  } catch (error) { return { status: 'unavailable', reason: connectionReason(error, 'TronGrid MCP'), source }; }
}
