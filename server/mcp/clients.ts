import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

export type ReadServer = 'justlend';
export type McpRead = { serverId: ReadServer; serverVersion: string | null; toolName: string; result: unknown };
export type McpInventory = { serverId: ReadServer; serverVersion: string | null; toolNames: string[] };

const READ_TOOLS = new Set(['get_supported_markets', 'get_market_data', 'get_all_markets']);

function entryFor(serverId: ReadServer): string | null {
  return serverId === 'justlend' ? process.env.JUSTLEND_MCP_ENTRY || null : null;
}

class StdioReadClient {
  private readonly child: ReturnType<typeof spawn>;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private outputBytes = 0;

  constructor(entry: string) {
    // No shell, no wallet credentials, and no package auto-install on server startup.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'production' };
    if (process.env.TRONGRID_API_KEY) env.TRONGRID_API_KEY = process.env.TRONGRID_API_KEY;
    this.child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'ignore'], env });
    if (!this.child.stdin || !this.child.stdout) throw new Error('MCP stdio unavailable');
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      this.outputBytes += Buffer.byteLength(line);
      if (this.outputBytes > 4_000_000) { this.close(); return; }
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof message.id !== 'number') return;
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error('MCP protocol error'));
        else waiter.resolve(message.result);
      } catch { /* MCP stdout can contain notifications; only JSON-RPC replies matter. */ }
    });
    this.child.on('error', () => this.rejectPending());
    this.child.on('exit', () => this.rejectPending());
  }

  private rejectPending() {
    for (const waiter of this.pending.values()) waiter.reject(new Error('MCP process exited'));
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (error) { this.pending.delete(id); reject(new Error('MCP write failed')); }
      });
    });
  }

  notify(method: string) { this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); }
  close() { this.rejectPending(); this.child.kill(); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MCP response');
  return value as Record<string, unknown>;
}

async function withClient<T>(serverId: ReadServer, action: (client: StdioReadClient, version: string | null) => Promise<T>): Promise<T> {
  const entry = entryFor(serverId);
  if (!entry) throw new Error('JustLend MCP local entry is not configured');
  if (!isAbsolute(entry) || !(await stat(entry).catch(() => null))?.isFile()) throw new Error('JustLend MCP entry is not a readable absolute file');
  const client = new StdioReadClient(entry);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('MCP timeout')), 15_000); });
  try {
    return await Promise.race([(async () => {
      const initialized = object(await client.request('initialize', {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'leemir-read-api', version: '0.1.0' },
      }));
      const serverInfo = object(initialized.serverInfo ?? {});
      client.notify('notifications/initialized');
      return action(client, typeof serverInfo.version === 'string' ? serverInfo.version : null);
    })(), timeout]);
  } finally { if (timer) clearTimeout(timer); client.close(); }
}

export async function inspectJustLendMcp(): Promise<McpInventory> {
  return withClient('justlend', async (client, serverVersion) => {
    const listed = object(await client.request('tools/list'));
    if (!Array.isArray(listed.tools)) throw new Error('Invalid MCP tools/list');
    const toolNames = listed.tools.map(item => object(item).name).filter((name): name is string => typeof name === 'string');
    return { serverId: 'justlend', serverVersion, toolNames: toolNames.filter(name => READ_TOOLS.has(name)) };
  });
}

export async function callJustLendRead(toolName: 'get_supported_markets' | 'get_market_data' | 'get_all_markets', args: Record<string, unknown>): Promise<McpRead> {
  if (!READ_TOOLS.has(toolName)) throw new Error('MCP tool is not read-allowlisted');
  if (args.network !== 'mainnet' && args.network !== 'nile') throw new Error('MCP network must be explicit');
  return withClient('justlend', async (client, serverVersion) => {
    const listed = object(await client.request('tools/list'));
    if (!Array.isArray(listed.tools) || !listed.tools.some(item => object(item).name === toolName)) throw new Error('MCP read tool not exposed');
    const called = object(await client.request('tools/call', { name: toolName, arguments: args }));
    if (called.isError === true) throw new Error('MCP read tool returned an error');
    let result: unknown = called.structuredContent;
    if (result === undefined && Array.isArray(called.content)) {
      const text = called.content.find(item => object(item).type === 'text');
      if (text) result = JSON.parse(String(object(text).text));
    }
    if (result === undefined) throw new Error('MCP read result missing');
    return { serverId: 'justlend', serverVersion, toolName, result };
  });
}
