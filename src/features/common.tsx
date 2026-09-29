import type { DataMode, Eligibility, SourceMeta, TxStatus } from "../../shared/schemas";
import { fmt } from "../../shared/units";

export function ModeBadge({ mode }: { mode: DataMode | "live" | "synthetic" }) {
  if (mode === "synthetic") return <span className="badge coral" title="가상 데이터. 실제 금리가 아닙니다">가상 시연</span>;
  if (mode === "snapshot") return <span className="badge amber">과거 데이터</span>;
  return <span className="badge teal">실데이터</span>;
}

export function ChainBadge({ chain }: { chain: "mainnet" | "nile" }) {
  return chain === "mainnet" ? <span className="badge gray">TRON Mainnet</span> : <span className="badge amber">Nile 테스트넷</span>;
}

export function EligibilityBadge({ e }: { e: Eligibility }) {
  if (e === "eligible") return <span className="badge teal">조건 충족</span>;
  if (e === "conditional") return <span className="badge amber">조건부</span>;
  return <span className="badge red">제외</span>;
}

const TX_LABEL: Record<TxStatus, [string, string]> = {
  preview: ["미리보기", "gray"],
  awaiting_signature: ["서명 대기", "amber"],
  submitted: ["제출됨", "amber"],
  pending: ["확정 대기 중", "amber"],
  confirmed: ["확정", "teal"],
  failed: ["실패", "red"],
  rejected: ["서명 거부", "gray"],
  unknown: ["방송 여부 확인 중", "amber"],
};
export function TxBadge({ s }: { s: TxStatus }) {
  const [label, color] = TX_LABEL[s];
  return <span className={`badge ${color}`}>{label}</span>;
}

export function Money({ v, asset, dp = 2, signed }: { v?: string; asset?: string; dp?: number; signed?: boolean }) {
  if (v === undefined) return <span className="muted">산정 불가</span>;
  const n = Number(v);
  const cls = signed ? (n > 0 ? "pos" : n < 0 ? "neg" : "") : "";
  return (
    <span className={cls}>
      {signed && n > 0 ? "+" : ""}
      {Number(fmt(v, dp)).toLocaleString("ko-KR", { minimumFractionDigits: dp, maximumFractionDigits: dp })}
      {asset ? ` ${asset}` : ""}
    </span>
  );
}

export function pct(v?: string, dp = 2) {
  if (v === undefined) return "-";
  return `${(Number(v) * 100).toFixed(dp)}%`;
}

export function SourceLine({ s }: { s: SourceMeta }) {
  return (
    <div className="tiny muted">
      <ModeBadge mode={s.mode} /> {s.chain === "mainnet" ? "Mainnet" : "Nile"} · {s.accessMethod === "mcp" ? `MCP ${s.serverId ?? ""} ${s.toolName ?? ""}` : s.accessMethod === "direct" ? "직접 조회" : "fixture"} · 조회{" "}
      {new Date(s.fetchedAt).toLocaleString("ko-KR")} ·{" "}
      {s.sourceUrl.startsWith("http") ? (
        <a href={s.sourceUrl} target="_blank" rel="noreferrer">
          출처
        </a>
      ) : (
        <code>{s.sourceUrl}</code>
      )}
      {s.note ? ` · ${s.note}` : ""}
    </div>
  );
}

export function timeKo(iso?: string) {
  return iso ? new Date(iso).toLocaleString("ko-KR") : "-";
}
