import type { ActionPreview, ChatMessage, ExecutionRecord, MissingField, Observation, PlanningResult, UserNeeds } from "../../shared/schemas";
import type { GoalAssessment } from "../../shared/monitor";

// 버전 있는 로컬 저장. 비밀 정보(키·복구 구문·개인키)는 저장하지 않는다.
// 새 데이터를 읽어도 원계획을 덮어쓰지 않고 목록에 새 버전으로 추가한다.

export const SCHEMA_VERSION = 3;
const KEY = "gwdc.planner.v3";
const LEGACY_KEY = "gwdc.planner.v2";

export type ConvState = "collecting" | "awaiting_confirmation" | "confirmed" | "comparing";

export interface PersistedState {
  schemaVersion: number;
  needs: UserNeeds;
  convState: ConvState;
  messages: ChatMessage[];
  lastAsked?: MissingField;
  confirmedVersion?: number;
  analyses: PlanningResult[];
  selectedPlanId?: string;
  monitoredGoal?: {
    baselineResultId: string;
    planKey: "A" | "B" | "C" | "L" | "HOLD";
    savedAt: string;
    latest?: GoalAssessment;
    history: GoalAssessment[];
  };
  nile: {
    needs?: UserNeeds;
    result?: PlanningResult;
    selectedPlanId?: string;
    preview?: ActionPreview;
    records: ExecutionRecord[];
    observations: Observation[];
  };
}

export function load(): PersistedState | undefined {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return undefined;
    const s = JSON.parse(raw) as PersistedState;
    if (s.schemaVersion === SCHEMA_VERSION) return s;
    if (s.schemaVersion === 2) {
      // Results calculated before the three-route planner are not comparable.
      return { ...s, schemaVersion: SCHEMA_VERSION, analyses: [], selectedPlanId: undefined, monitoredGoal: undefined };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function save(s: PersistedState): string | undefined {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return undefined;
  } catch (e) {
    return `로컬 저장 실패 (${(e as Error).name}). JSON 내보내기로 백업하세요.`;
  }
}

export function clear() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* noop */
  }
}
