import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Trx, TronWeb, utils } from 'tronweb';
import { createActionLedger } from '../server/agent/ledger';
import type { NileDepositPreview } from '../server/transactions';
import type { Plan, UserNeeds } from '../shared/schemas';

type Intent = { id: string; status: string; txId: string | null; needsDigest?: string };
type TestWallet = { address: string; privateKey: string };
const origin = 'http://127.0.0.1:5173';
const referenceHeight = 99_999;
const referenceId = `${referenceHeight.toString(16).padStart(16, '0')}${'ab'.repeat(24)}`;

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

function testWallet(): TestWallet {
  const privateKey = randomBytes(32).toString('hex');
  const address = TronWeb.address.fromPrivateKey(privateKey);
  if (!address) throw new Error('시험 전용 지갑 생성 실패');
  return { address, privateKey };
}

function needs(): UserNeeds {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const future = (days: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString().slice(0, 10);
  const trx = { symbol: 'TRX', address: null, decimals: 6 } as const;
  return { chain: 'nile', asset: trx, amount: '100', startDate: today, endDate: future(30),
    expenses: [{ date: future(7), amount: '10', asset: trx }], liquidReserve: '0',
    riskPreference: 'balanced', acceptsUsddRisk: false, timezone: 'Asia/Seoul',
    inputVersion: 1, confirmedVersion: 1 };
}

function signedTransaction(wallet: TestWallet, preview: NileDepositPreview, expiryOffset = 0) {
  const timestamp = Date.now();
  const raw_data = {
    ref_block_bytes: referenceId.slice(12, 16), ref_block_hash: referenceId.slice(16, 32),
    timestamp, expiration: timestamp + 90_000 + expiryOffset,
    fee_limit: Number(preview.feeLimitSun),
    contract: [{ type: 'TriggerSmartContract', parameter: { value: {
      owner_address: TronWeb.address.toHex(wallet.address),
      contract_address: TronWeb.address.toHex(preview.contractAddress),
      call_value: Number(preview.amountBaseUnits),
      data: TronWeb.sha3('mint()').replace(/^0x/, '').slice(0, 8),
    } } }],
  };
  const pb = utils.transaction.txJsonToPb({ raw_data });
  const txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '');
  return { raw_data, raw_data_hex: utils.transaction.txPbToRawDataHex(pb), txID,
    signature: [utils.crypto.ECKeySign(Buffer.from(txID, 'hex'), Buffer.from(wallet.privateKey, 'hex'))] };
}

describe('approval HTTP C-04/C-06 process restart gate', () => {
  it('keeps one intent and one original txID across two clients and three abrupt server restarts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gwdc-approval-http-restart-'));
    const ledgerPath = join(directory, 'approval.sqlite');
    const rpcLog = join(directory, 'rpc.jsonl');
    const key = randomBytes(32);
    const port = await unusedPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const wallet = testWallet();
    const confirmedNeeds = needs();
    let server: ChildProcessWithoutNullStreams | null = null;

    async function startServer() {
      const child = spawn(process.execPath,
        ['--import', 'tsx', '--import', './tests/fixtures/nile-http-rpc.mjs', 'server/index.ts'], {
          cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, HOME: process.env.HOME, API_PORT: String(port), UI_PORT: '5173',
            GWDC_APPROVAL_LEDGER_KEY_HEX: key.toString('hex'), GWDC_APPROVAL_LEDGER_PATH: ledgerPath,
            GWDC_TEST_RPC_LOG: rpcLog },
        });
      let errors = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { errors += chunk; });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        try {
          const health = await fetch(`${baseUrl}/api/health`);
          if (health.ok && (await health.json() as { nileApprovalLedgerReady?: boolean }).nileApprovalLedgerReady) {
            server = child;
            return;
          }
        } catch { /* Waiting for the child listener. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      child.kill('SIGKILL');
      throw new Error(`Approval HTTP child did not start: ${errors}`);
    }

    async function stopServer() {
      const child = server;
      server = null;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const stopped = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGKILL');
      await stopped;
    }

    function post(path: string, body: unknown, cookie?: string): Promise<Response> {
      return fetch(`${baseUrl}${path}`, { method: 'POST', headers: {
        'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
      }, body: JSON.stringify(body) });
    }

    async function json<T>(response: Response): Promise<T> {
      const body = await response.json() as T;
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
      return body;
    }

    async function authenticate(): Promise<string> {
      const challenge = await json<{ challengeId: string; message: string }>(
        await post('/api/approval/challenge', { address: wallet.address }));
      const response = await post('/api/approval/authenticate', {
        challengeId: challenge.challengeId, address: wallet.address,
        signature: Trx.signMessageV2(challenge.message, wallet.privateKey),
      });
      expect(response.status).toBe(200);
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      expect(cookie).toMatch(/^gwdc_nile_approval=[0-9a-f]{64}$/);
      return cookie!;
    }

    async function unresolved(cookie: string): Promise<Intent[]> {
      return (await json<{ intents: Intent[] }>(await fetch(`${baseUrl}/api/approval/unresolved`,
        { headers: { Cookie: cookie } }))).intents;
    }

    try {
      await startServer();
      const plans = await json<{ plans: Plan[] }>(await post('/api/nile/plans',
        { needs: confirmedNeeds, address: wallet.address }));
      const plan = plans.plans.find(item => item.scenario === '80_20');
      expect(plan?.quoteVersion).toBeTruthy();
      const [previewA, previewB] = await Promise.all([
        json<NileDepositPreview>(await post('/api/preview', { needs: confirmedNeeds, planId: plan!.id, address: wallet.address })),
        json<NileDepositPreview>(await post('/api/preview', { needs: confirmedNeeds, planId: plan!.id, address: wallet.address })),
      ]);
      expect(previewA.id).not.toBe(previewB.id);
      expect(previewA.fingerprint).toBe(previewB.fingerprint);
      const [clientA, clientB] = await Promise.all([authenticate(), authenticate()]);
      const responses = await Promise.all([
        post('/api/approval/reserve', { preview: previewA, confirmedPreviewId: previewA.id,
          needs: confirmedNeeds }, clientA),
        post('/api/approval/reserve', { preview: previewB, confirmedPreviewId: previewB.id,
          needs: confirmedNeeds }, clientB),
      ]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const winner = responses[0].ok ? 0 : 1;
      const selected = winner === 0 ? previewA : previewB;
      const reserved = await json<{ intent: Intent }>(responses[winner]);
      expect(reserved.intent).toMatchObject({ status: 'reserved', txId: null,
        needsDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(await unresolved(clientA)).toMatchObject([{ id: reserved.intent.id, status: 'reserved', txId: null }]);
      expect(await unresolved(clientB)).toHaveLength(1);

      // C-04/C-06: terminate the actual HTTP process after durable reservation.
      await stopServer();
      await startServer();
      expect((await post('/api/approval/cancel', { intentId: reserved.intent.id }, clientA)).status).toBe(401);
      const afterReserveA = await authenticate();
      const afterReserveB = await authenticate();
      expect(await unresolved(afterReserveA)).toMatchObject([{ id: reserved.intent.id, status: 'reserved' }]);
      const losing = winner === 0 ? previewB : previewA;
      expect((await post('/api/approval/reserve', { preview: losing, confirmedPreviewId: losing.id,
        needs: confirmedNeeds }, afterReserveB)).status).toBe(409);

      const original = signedTransaction(wallet, selected);
      const signed = await json<{ intent: Intent }>(await post('/api/approval/signed', {
        intentId: reserved.intent.id, preview: selected, signedTransaction: original,
      }, afterReserveA));
      expect(signed.intent).toMatchObject({ status: 'signed', txId: original.txID });
      await stopServer();
      const ledger = createActionLedger({ path: ledgerPath, encryptionKey: key });
      try {
        expect(ledger.getIntent(reserved.intent.id)).toMatchObject({ status: 'signed', txId: original.txID });
        expect(ledger.getSignedTransaction(reserved.intent.id)).toEqual(original);
        expect(ledger.listEvents(reserved.intent.id).map(event => event.event)).toEqual(['reserved', 'signed']);
      } finally { ledger.close(); }
      expect(readFileSync(ledgerPath).toString('utf8')).not.toContain(original.raw_data_hex);

      // Signed evidence survives restart. A different signed txID cannot replace it.
      await startServer();
      const afterSignedA = await authenticate();
      const afterSignedB = await authenticate();
      const replacement = signedTransaction(wallet, selected, 1_000);
      expect(replacement.txID).not.toBe(original.txID);
      expect((await post('/api/approval/signed', { intentId: reserved.intent.id,
        preview: selected, signedTransaction: replacement }, afterSignedB)).status).toBe(409);
      const broadcastReady = await json<{ intent: Intent; signedTransaction: typeof original }>(
        await post('/api/approval/begin-broadcast', {
          intentId: reserved.intent.id, preview: selected,
        }, afterSignedA));
      expect(broadcastReady.intent).toMatchObject({ status: 'broadcasting', txId: original.txID });
      expect(broadcastReady.signedTransaction).toEqual(original);

      // The server has committed a single attempt, but this test never calls TronLink broadcast.
      await stopServer();
      await startServer();
      const afterAttemptA = await authenticate();
      const afterAttemptB = await authenticate();
      expect(await unresolved(afterAttemptA)).toMatchObject([{
        id: reserved.intent.id, status: 'broadcasting', txId: original.txID,
      }]);
      const repeated = await Promise.all([afterAttemptA, afterAttemptB].map(cookie =>
        post('/api/approval/begin-broadcast', { intentId: reserved.intent.id, preview: selected }, cookie)));
      expect(repeated.map(response => response.status)).toEqual([409, 409]);
      expect((await post('/api/approval/reserve', { preview: losing, confirmedPreviewId: losing.id,
        needs: confirmedNeeds }, afterAttemptB)).status).toBe(409);
      const unknown = await json<{ intent: Intent }>(await post('/api/approval/broadcast-result',
        { intentId: reserved.intent.id, accepted: null }, afterAttemptA));
      expect(unknown.intent).toMatchObject({ status: 'unknown', txId: original.txID });
      const reconciled = await json<{ intent: Intent; observation: { txId: string; status: string } }>(
        await post('/api/approval/reconcile', { intentId: reserved.intent.id }, afterAttemptA));
      expect(reconciled.intent).toMatchObject({ status: 'unknown', txId: original.txID });
      expect(reconciled.observation).toMatchObject({ txId: original.txID, status: 'pending' });
      expect(readFileSync(rpcLog, 'utf8')).not.toContain('broadcasttransaction');
    } finally {
      await stopServer();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
