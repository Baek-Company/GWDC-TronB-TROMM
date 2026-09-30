import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectTronGridMcp, readTronGridMcp, TRONGRID_MCP_URL, type TronGridReadTool } from '../server/mcp/trongrid';

afterEach(() => vi.unstubAllGlobals());

function rpcReply(id: number, result: unknown, session = false): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200, headers: { 'Content-Type': 'application/json', ...(session ? { 'mcp-session-id': 'session-123' } : {}) },
  });
}

describe('official TronGrid MCP read adapter', () => {
  it('completes the documented handshake and exposes only API query tools', async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const message = JSON.parse(String(options.body)) as { id?: number; method: string };
      if (message.method === 'initialize') return rpcReply(1, {
        protocolVersion: '2025-11-25', serverInfo: { name: 'TronGrid', version: '1.11.0' },
      }, true);
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (message.method === 'tools/list') return rpcReply(2, { tools: [
        { name: 'getBlockStatistics' }, { name: 'getEventsByLatestBlock' },
        { name: 'broadcastTransaction' }, { name: 'getAccount' }, { name: 'solidityGetAccount' },
      ] });
      throw new Error('Unexpected MCP method');
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await inspectTronGridMcp();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.value.toolNames).toEqual(['getBlockStatistics', 'getEventsByLatestBlock']);
    expect(result.value.serverVersion).toBe('1.11.0');
    expect(result.source.chain).toBe('mainnet');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url === TRONGRID_MCP_URL)).toBe(true);
    const listedOptions = fetchMock.mock.calls[2][1];
    expect((listedOptions.headers as Record<string, string>)['mcp-session-id']).toBe('session-123');
    expect((listedOptions.headers as Record<string, string>)['MCP-Protocol-Version']).toBe('2025-11-25');
  });

  it('calls only an advertised read tool and keeps its output unverified', async () => {
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      const message = JSON.parse(String(options.body)) as { method: string; params?: Record<string, unknown> };
      calls.push(message);
      if (message.method === 'initialize') return rpcReply(1, { protocolVersion: '2025-11-25' }, true);
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (message.method === 'tools/list') return rpcReply(2, { tools: [{ name: 'getBlockStatistics' }] });
      if (message.method === 'tools/call') return rpcReply(3, { structuredContent: { block: '68000000' } });
      throw new Error('Unexpected MCP method');
    }));
    const result = await readTronGridMcp('getBlockStatistics', { blockNum: 68000000 });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.value.outputSchemaVerified).toBe(false);
    expect(result.source.toolName).toBe('getBlockStatistics');
    expect(calls.at(-1)).toMatchObject({ method: 'tools/call', params: {
      name: 'getBlockStatistics', arguments: { blockNum: 68000000 },
    } });
  });

  it('shares the inventory handshake for parallel source inventory and read requests', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      const message = JSON.parse(String(options.body)) as { method: string };
      methods.push(message.method);
      if (message.method === 'initialize') return rpcReply(1, { protocolVersion: '2025-11-25' }, true);
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (message.method === 'tools/list') return rpcReply(2, { tools: [{ name: 'getEventsByLatestBlock' }] });
      if (message.method === 'tools/call') return rpcReply(3, { structuredContent: { block: 'latest' } });
      throw new Error('Unexpected method');
    }));
    const [inventory, read] = await Promise.all([
      inspectTronGridMcp(), readTronGridMcp('getEventsByLatestBlock', {}),
    ]);
    expect(inventory.status).toBe('ready');
    expect(read.status).toBe('ready');
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  });

  it('rejects wallet and write tools before any network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await readTronGridMcp('broadcastTransaction' as TronGridReadTool, {});
    expect(result.status).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses Streamable HTTP event responses and paginated tool discovery', async () => {
    const eventReply = (id: number, result: unknown, session = false) => new Response(
      new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`,
        ));
        // Keep the SSE stream open after the response event, as a live server may do.
      } }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream', ...(session ? { 'mcp-session-id': 'session-456' } : {}) } },
    );
    let listPage = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      const message = JSON.parse(String(options.body)) as { method: string; params?: { cursor?: string } };
      if (message.method === 'initialize') return eventReply(1, { protocolVersion: '2025-11-25' }, true);
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (message.method === 'tools/list') {
        listPage++;
        if (listPage === 1) return eventReply(2, { tools: [{ name: 'broadcastTransaction' }], nextCursor: 'next' });
        expect(message.params?.cursor).toBe('next');
        return eventReply(3, { tools: [{ name: 'getTrc20Info' }] });
      }
      throw new Error('Unexpected MCP method');
    }));
    const result = await inspectTronGridMcp();
    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(result.value.toolNames).toEqual(['getTrc20Info']);
  });

  it('reports an invalid session or missing official tool without claiming data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rpcReply(1, { protocolVersion: '2025-11-25' })));
    const result = await inspectTronGridMcp();
    expect(result.status).toBe('unavailable');
  });
});
