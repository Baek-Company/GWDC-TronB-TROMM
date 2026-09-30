// Child-process-only Nile RPC fixture for approval HTTP failure/restart tests.
// No request from this preloaded process can reach an external host.
// GWDC_TEST_RPC_CONTROL points to JSON read before every RPC request:
// {
//   "faults": [{ "path": "/wallet/estimateenergy", "selector": "mint()",
//     "owner": "optional address", "method": "POST", "nth": 1, "kind": "429" | "timeout" }],
//   "values": { "quoteCashSun": "1000000000", "previewCashSun": "900000000" }
// }
// Omitted match fields are wildcards; nth counts matching path/selector/owner/method calls.
// Rewriting the control file between HTTP operations changes subsequent RPC responses.
import { appendFileSync, readFileSync } from 'node:fs';
import { TronWeb } from 'tronweb';

const contract = 'TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq';
const comptroller = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const quoteOwner = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const word = value => BigInt(value).toString(16).padStart(64, '0');
const calls = [];
const block = (height, timestamp, hash) => ({
  blockID: `${height.toString(16).padStart(16, '0')}${hash.repeat(24)}`,
  block_header: { raw_data: { number: height, timestamp } },
});

function control() {
  const path = process.env.GWDC_TEST_RPC_CONTROL;
  if (!path) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GWDC_TEST_RPC_CONTROL must contain a JSON object');
  }
  return parsed;
}

function matches(fault, call) {
  return ['path', 'selector', 'owner', 'method'].every(key =>
    fault[key] === undefined || fault[key] === call[key]);
}

function selectedFault(config, call) {
  for (const fault of config.faults ?? []) {
    if (!matches(fault, call)) continue;
    if (fault.nth !== undefined) {
      const count = calls.filter(item => matches(fault, item)).length;
      if (count !== fault.nth) continue;
    }
    if (fault.kind !== '429' && fault.kind !== 'timeout') {
      throw new Error(`Unsupported Nile RPC fault kind: ${fault.kind}`);
    }
    return fault.kind;
  }
  const legacy = process.env.GWDC_TEST_RPC_FAULT;
  if (legacy === 'quote-429' && call.path === '/wallet/getcontract' ||
      legacy === 'preview-429' && call.path === '/wallet/getcontractinfo') return '429';
  if (legacy === 'quote-timeout' && call.path === '/wallet/getcontract' ||
      legacy === 'preview-timeout' && call.path === '/wallet/getcontractinfo') return 'timeout';
  return null;
}

globalThis.fetch = async (request, init = {}) => {
  const url = new URL(request instanceof Request ? request.url : String(request));
  if (url.origin !== 'https://nile.trongrid.io') {
    throw new Error(`Test server refused outbound fetch to ${url.origin}`);
  }
  const path = url.pathname;
  const method = init.method ?? (request instanceof Request ? request.method : 'GET');
  const body = method === 'GET' ? Object.fromEntries(url.searchParams)
    : JSON.parse(String(init.body ?? '{}'));
  const selector = String(body.function_selector ?? '');
  const owner = String(body.owner_address ?? '');
  const call = { path, selector, owner, method };
  calls.push(call);
  const config = control();
  const fault = selectedFault(config, call);
  if (process.env.GWDC_TEST_RPC_LOG) {
    appendFileSync(process.env.GWDC_TEST_RPC_LOG,
      `${JSON.stringify({ ...call, fault })}\n`);
  }
  if (path === '/wallet/broadcasttransaction' || path === '/wallet/easytransfer') {
    throw new Error('Broadcast is forbidden in the approval HTTP test');
  }
  if (fault === '429') {
    return new Response('{}', { status: 429 });
  }
  if (fault === 'timeout') {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  }

  const values = config.values ?? {};
  const isQuote = owner === quoteOwner;

  let response;
  if (path === '/wallet/getcontract') {
    response = { bytecode: '60016000', abi: { entrys: [] } };
  } else if (path === '/wallet/getcontractinfo') {
    response = body.value === comptroller ? { runtimecode: '6001' } : {
      runtimecode: '60016000',
      smart_contract: { contract_address: contract, abi: { entrys: [
        ...['symbol', 'decimals', 'balanceOf', 'exchangeRateStored', 'exchangeRateCurrent', 'getCash',
          'comptroller', 'supplyRatePerBlock'].map(name => ({ name, type: 'Function', stateMutability: 'View' })),
        { name: 'mint', type: 'Function', stateMutability: 'Payable', inputs: [] },
        { name: 'redeem', type: 'Function', stateMutability: 'Nonpayable', inputs: [{ type: 'uint256' }] },
      ] } },
    };
  } else if (path === '/wallet/triggerconstantcontract') {
    let result;
    if (selector === 'comptroller()') result = word(`0x${TronWeb.address.toHex(comptroller).slice(2)}`);
    else if (selector === 'decimals()') result = word(8);
    else if (selector === 'symbol()') result = word(32) + word(4) + Buffer.from('jTRX').toString('hex').padEnd(64, '0');
    else if (selector === 'markets(address)') result = word(isQuote
      ? values.quoteMarketListed === false ? 0 : 1
      : values.previewMarketListed === false ? 0 : 1) + word(0) + word(0);
    else if (selector === 'balanceOf(address)') result = word(100_000_000);
    else if (selector === 'exchangeRateStored()' || selector === 'exchangeRateCurrent()') result =
      word(isQuote ? values.quoteExchangeRateRaw ?? '2000000000000000000'
        : values.previewExchangeRateRaw ?? '2000000000000000000');
    else if (selector === 'getCash()') result = word(isQuote
      ? values.quoteCashSun ?? (process.env.GWDC_TEST_RPC_FAULT === 'quote_cash_mismatch'
        ? '1200000000' : '1000000000')
      : values.previewCashSun ?? '1000000000');
    else if (selector === 'supplyRatePerBlock()') result = word(isQuote
      ? values.quoteSupplyRateRaw ?? '100' : values.previewSupplyRateRaw ?? '100');
    else if (selector === 'mint()' || selector === 'redeem(uint256)') result = word(0);
    else throw new Error(`Unexpected Nile constant selector: ${selector}`);
    response = { result: { result: true }, constant_result: [result], energy_used: 100_000 };
  } else if (path === '/wallet/getaccount') {
    response = { address: body.address, balance: method === 'GET'
      ? values.previewWalletBalanceSun ?? '300000000'
      : values.quoteWalletBalanceSun ?? '300000000' };
  } else if (path === '/wallet/getaccountresource') {
    response = { EnergyLimit: '0', EnergyUsed: '0', freeNetLimit: '600', freeNetUsed: '0' };
  } else if (path === '/wallet/getchainparameters') {
    response = { chainParameter: [
      { key: 'getEnergyFee', value: 100 }, { key: 'getTransactionFee', value: 1000 },
      { key: 'getMaxFeeLimit', value: 15_000_000_000 },
    ] };
  } else if (path === '/wallet/estimateenergy') {
    response = { result: { result: true }, energy_required: 100_000 };
  } else if (path === '/wallet/triggersmartcontract') {
    response = { result: { result: true }, transaction: { raw_data_hex: 'ab'.repeat(250) } };
  } else if (path === '/wallet/getnowblock') {
    response = block(100_000, Date.now() - 3_000, 'cd');
  } else if (path === '/wallet/getblockbynum') {
    response = block(Number(body.num), Date.now() - 6_000, 'ab');
  } else if (path === '/walletsolidity/gettransactionbyid' || path === '/walletsolidity/gettransactioninfobyid') {
    response = {};
  } else {
    throw new Error(`Unexpected Nile RPC endpoint: ${path}`);
  }
  return new Response(JSON.stringify(response), { status: 200,
    headers: { 'Content-Type': 'application/json' } });
};
