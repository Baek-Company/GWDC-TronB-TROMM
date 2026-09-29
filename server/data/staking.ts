import { TronWeb } from "tronweb";
import { HOSTS, post } from "./tron-rpc";
import type { ProductQuote } from "../../shared/schemas";

const BLOCKS_PER_YEAR = 10_512_000;
const PRODUCERS = 27;
const CACHE_MS = 5 * 60_000;

let cached: { at: number; value: ProductQuote } | undefined;

interface Witness {
  address: string;
  voteCount?: number;
  url?: string;
}

/**
 * Select the currently best net-voter-APR SR from the active producers.
 * Stake 2.0 itself does not earn interest: the projected return comes from
 * voting for the selected SR after its brokerage fee.
 */
export async function fetchStakingQuote(): Promise<ProductQuote> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const [parameters, witnesses] = await Promise.all([
    post<{ chainParameter: { key: string; value?: number }[] }>("mainnet", "/wallet/getchainparameters", {}),
    post<{ witnesses: Witness[] }>("mainnet", "/wallet/listwitnesses", {}),
  ]);
  const parameter = (key: string) => parameters.chainParameter.find((item) => item.key === key)?.value;
  const blockRewardSun = parameter("getWitnessPayPerBlock");
  const voteRewardSun = parameter("getWitness127PayPerBlock");
  const unfreezeDelayDays = parameter("getUnfreezeDelayDays");
  const maintenanceMs = parameter("getMaintenanceTimeInterval");
  if (!blockRewardSun || !voteRewardSun || !unfreezeDelayDays) throw new Error("Stake 2.0 보상 또는 해제 대기 파라미터를 찾지 못했습니다.");

  const ranked = witnesses.witnesses
    .filter((item) => (item.voteCount ?? 0) > 0)
    .sort((left, right) => (right.voteCount ?? 0) - (left.voteCount ?? 0));
  const candidates = ranked.slice(0, PRODUCERS);
  if (!candidates.length) throw new Error("활성 SR 후보를 찾지 못했습니다.");

  const brokerages = await Promise.all(candidates.map(async (candidate) => {
    const response = await post<{ brokerage?: number }>("mainnet", "/wallet/getBrokerage", { address: candidate.address }).catch((): { brokerage?: number } => ({}));
    return response.brokerage;
  }));
  const totalVotes = ranked.slice(0, 127).reduce((sum, item) => sum + BigInt(item.voteCount ?? 0), 0n);
  if (!totalVotes) throw new Error("SR 득표수를 확인하지 못했습니다.");

  const blockRewardTrx = blockRewardSun / 1_000_000;
  const voteRewardTrx = voteRewardSun / 1_000_000;
  let best: { witness: Witness; brokerage: number; apr: number } | undefined;
  candidates.forEach((candidate, index) => {
    const brokerage = brokerages[index];
    const votes = candidate.voteCount ?? 0;
    if (brokerage === undefined || !votes) return;
    const annualBlockShare = (blockRewardTrx * BLOCKS_PER_YEAR) / PRODUCERS;
    const annualVoteShare = voteRewardTrx * BLOCKS_PER_YEAR * (votes / Number(totalVotes));
    const apr = ((annualBlockShare + annualVoteShare) * (1 - brokerage / 100)) / votes;
    if (!best || apr > best.apr) best = { witness: candidate, brokerage, apr };
  });
  if (!best) throw new Error("SR 수수료를 확인하지 못해 투표 보상률을 계산할 수 없습니다.");

  const address = TronWeb.address.fromHex(best.witness.address);
  const fetchedAt = new Date().toISOString();
  const value: ProductQuote = {
    id: "mainnet:TRX-STAKE-VOTE",
    kind: "staking",
    market: "TRX 스테이킹 + SR 투표",
    token: "TRX",
    address,
    chain: "mainnet",
    baseRate: String(best.apr),
    rateType: "APR",
    active: true,
    rewards: { status: "none", note: "Stake 2.0 투표 보상을 기본 수익에 포함했습니다." },
    staking: {
      srAddress: address,
      srName: (best.witness.url ?? address).replace(/^https?:\/\//, "").replace(/\/$/, ""),
      brokerage: String(best.brokerage / 100),
      unfreezeDelayDays,
      voteDelayDays: String((maintenanceMs ?? 21_600_000) / 86_400_000),
    },
    source: {
      sourceUrl: `${HOSTS.mainnet}/wallet/listwitnesses`,
      chain: "mainnet",
      fetchedAt,
      mode: "live",
      accessMethod: "direct",
      note: "getchainparameters, listwitnesses, getBrokerage로 계산한 상위 27개 SR 중 최대 순 투표 APR",
    },
  };
  cached = { at: Date.now(), value };
  return value;
}
