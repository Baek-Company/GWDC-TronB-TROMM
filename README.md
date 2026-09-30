# GWDC 2026 · TRON 자산 계획

LeeMir은 요구 수집·계획 계산·시장 조회·Nile 시험 거래 경로를 담은 TRON 자산 계획 시연 앱입니다. **첫 화면 `/`과 `/nile`은 Nile TRX·jTRX 시연과 별도의 PSM USDD↔USDT 시험 화면**입니다. 기존 밝은 USDT 개요는 `/usdt-demo`로 옮겼고, `/plans`도 실잔액 검증 없는 **synthetic 연 5% APY의 비용 전 예상 이자**만 보여줍니다. [프로젝트 원계획](docs/PROJECT_PLAN.md)의 체인 분리 원칙에 따라 두 사례의 자산·금리·거래 증거를 합치지 않습니다.

## 실행

Node.js 24와 npm이 필요합니다. macOS의 `scripts/run`은 설치된 Homebrew Node 24를 선택합니다.

```sh
cd LeeMir
./scripts/run run dev
```

기본 화면은 `http://127.0.0.1:5173`, API는 `http://127.0.0.1:8787/api/health`입니다. `UI_PORT`·`API_PORT`로 포트를 바꿀 수 있습니다. Vite는 화면 변경을 갱신하고 개발 명령은 `server/`·`shared/` 코드 변경 시 API를 다시 시작합니다. macOS 파일 감시 한도를 고려해 지정된 디렉터리만 감시합니다.

```sh
./scripts/run run check
./scripts/run run doctor
```

`check`는 Vitest·TypeScript·빌드를 실행합니다. `doctor`는 각 공식 읽기/키/계약 게이트를 `ready`, `unknown`, `unavailable`로 구분합니다. 네트워크가 없을 때는 라이브 값을 만들어 내지 않습니다.

## 화면과 흐름

| 화면 | 현재 시연 경로 |
| --- | --- |
| 첫 화면 `/`·`/nile` | Nile 블록·지갑 네트워크·저장된 거래 근거, 가상 TRX와 최대 10건의 날짜별 지출, 지출 보호분을 뺀 운용 상한, jTRX 시험 계획 |
| USDT 개요 `/usdt-demo` | 한국시간 7일 달력과 가상 보유액−예정 지출·예비액, 연 5% 가정의 비용 전 이자 |
| 요구 분석 | 명시 정보 JSON·누락 질문·요약 확인과 수정 시 재확인, NIM `openai/gpt-oss-20b` 문장 추출과 템플릿 대체, 시장 질문 조사, 날짜별 배분 평가·읽기 전용 기준선 보관 |
| USDT 계산 `/plans` | 지갑·시장 조회와 분리된 고정 예시 APY의 비용 전 이자, 비용·순익·실행 적격성 미확인 표시 |
| 시장 데이터 `/markets` | 화면 진입/수동 갱신 때 JustLend Mainnet REST 조회. PSM, Stake 2.0, SUN.io, MCP의 상태는 별도 출처·연결 화면에서 확인 |
| Nile TRX·jTRX 시험 | TRX 80/20·50/50 계산, TronLink Nile 계정 확인, 계약·잔고·수수료 미리보기, 별도 확인·단일 예치 서명, 원 txID·solidified 상태·동일 포지션 재조회. 확정 예치 뒤에는 jTRX 환매 사전 검증·별도 서명·원 거래 추적. 영수증의 실제 수령 TRX가 검증된 경우에만 회수 흐름을 기록 |
| Nile PSM 단독 시험 | PSM용 USDD·USDT 계약과 잔고, 양방향 용량·수수료 및 단계별 Energy/Bandwidth를 검증합니다. USDD 승인→USDT 수령→USDT 승인→USDD 수령은 각각 사용자 확인·TronLink 서명·원 txID·solidified 영수증·잔고 재조회가 필요합니다. 동명 다른 토큰과 jUSDD 예치 경로는 포함하지 않습니다. |
| 목표 감시·기록 검토 | 보관한 단일 계획 또는 날짜별 배분안을 화면 진입·5분 간격·탭 복귀 시 재조회해 유지/신규 예치 보류/계획 재검토 표시. 기존 거래 계획의 예치/환매/포지션 연결 검증, 근거 부족 시 손익 보류, 실행 없는 조정 초안, 세션 JSON 내보내기와 별도 과거·가상 시나리오 JSON 재생 |

세션의 가상 입력·확인 버전·선택 계획·감시 기준선·Nile 원 거래 기록은 브라우저 `localStorage`에 버전을 붙여 저장합니다. 개인키나 복구 구문을 앱에 입력하거나 저장하지 않습니다. 대화 입력은 요청 시에만 서버로 보내며, NIM 키가 설정된 경우 NVIDIA로 전송됩니다. 2026-09-29 서버의 실제 NIM 요구 추출에서 보유액·지출액·지출일과 다음 질문 반환을 확인했습니다. 가상 날짜별 배분의 보관·목표 감시 화면 표시와 Mainnet 지갑의 읽기 전용 조회 일부를 브라우저에서 확인했습니다. 시험 전용 Nile 지갑의 사용자 승인형 1 TRX 예치·89.46435499 jTRX 환매는 [실증 기록](docs/NILE_A_EVIDENCE.md)에서 두 원 txID·solidified 영수증·같은 포지션·실수령 TRX로 확인했습니다. Mainnet 또는 무인 거래의 증거는 아닙니다.

Nile 입력 저장이 실패하거나 한국시간 날짜가 바뀌면 기존 확인과 미리보기를 사용한 서명을 차단합니다. 다른 탭에서 같은 Nile 지갑에 미확정 거래가 있으면 원 txID를 확인할 때까지 새 거래를 차단합니다.

승인형 Nile 거래의 원 의도와 서명 거래는 브라우저 기록과 별도로 로컬 서버의 암호화된 SQLite 원장에 보관합니다. 방송 전에 서버 접수가 실패하면 거래를 제출하지 않습니다.

Nile 승인형 A 흐름은 **미리보기 확인 → TronLink 지갑 소유 메시지 서명 → 서버의 최신 지출 보호·견적·잔액 재검증 및 거래 예약 → 사용자님의 별도 TronLink 거래 서명 → 서버의 원 txID·서명 거래 원문 접수 → 브라우저의 원문 제출 → solidified 영수증과 같은 포지션 재조회** 순서입니다. 지갑 소유 서명은 거래 서명을 대신하지 않습니다. 서버의 승인 세션은 같은 로컬 화면 출처·Nile 계정에 묶인 `HttpOnly`, `SameSite=Strict` 쿠키로 10분간 유지됩니다. API를 재시작하면 세션을 다시 인증하지만 원장에 접수된 거래 근거는 보존합니다.

Nile PSM도 이 서버 인증·암호화 원장을 재사용합니다. 현재 시험 지갑에 들어온 2,000 USDD는 PSM 입력 USDD와 **계약 주소가 달라** PSM 잔고는 0입니다. PSM 기능의 코드·모의 테스트·읽기 검증은 완료했지만 실거래 성공으로 판정하지 않습니다. [PSM 단계와 토큰 확인 기록](docs/NILE_PSM_EXECUTION.md)을 확인해 주세요.

새로고침이나 응답 유실로 상태가 불명확하면 첫 화면의 **`서버 미해결 거래 확인·복구`**를 누릅니다. 서명 전 `reserved` 예약만 서버 취소를 확인한 뒤 새 미리보기를 만들 수 있습니다. 서명 후에는 보관된 원 txID를 조회하며 새 서명이나 재방송을 하지 않습니다. 확정 예치의 같은 계정·계획·계약·서버 의도 ID를 확인한 뒤에만 환매 미리보기를 열고, 환매는 별도 지갑 확인과 거래 서명이 필요합니다. 자세한 순서는 [시연 대본](docs/DEMO.md), 실거래 증거 상태는 [Nile 승인형 실증 증거](docs/NILE_A_EVIDENCE.md)에 있습니다.

## 설정과 안전 경계

`.env.example`을 참고해 필요한 설정을 로컬 `.env.local`에 입력합니다. 이 파일은 Git에서 제외됩니다. 채팅에 노출된 키를 재사용하지 말고 새 키를 설정해 주세요. `NVIDIA_API_KEY`는 서버에서만 읽습니다. `TRONGRID_API_KEY`는 RPC 읽기 제한을 완화할 수 있지만 실제 계약·시장 검증을 대신하지 않습니다. `JUSTLEND_MCP_ENTRY`는 검토된 로컬 서버 엔트리의 절대 경로입니다. USDD MCP는 시작 시 로컬 지갑 생성 가능성이 있어 자동 실행하지 않고 PSM의 읽기 전용 RPC를 사용합니다.

다른 UI 포트에서 실행할 경우 `UI_PORT`를 같은 값으로 설정해야 API의 로컬 출처 검사를 통과합니다. 최소 운용액 탐색은 고정 왕복 비용이 적용되는 금액 범위를 서버 자료로 확인했을 때만 값을 반환합니다. 현재 데이터에는 이 근거가 없어 결과를 보류합니다. 재생 JSON은 과거 자료(`snapshot`) 또는 명시적 가상 자료(`synthetic`)만 받으며 거래를 실행하지 않습니다.

Nile 승인형 거래에는 로컬에서 생성한 32바이트 난수의 64자리 hex 값을 `.env.local`의 `GWDC_APPROVAL_LEDGER_KEY_HEX`에 설정해야 합니다. 키가 없으면 승인 API는 503으로 닫힙니다. 원장은 기본 `tmp/nile-approval.sqlite`에 보관되며 Git 제외 대상입니다. 키를 잃으면 미확정 서명 원문을 복구할 수 없으므로 시험 도중 교체하지 마세요. 키 값과 서명 원문을 문서·Git·채팅에 기록하지 않습니다.

설정 뒤 API를 재시작하고 `/api/health`의 `nileApprovalLedgerReady:true`를 확인합니다. 이 표시는 로컬 원장 준비 여부만 뜻합니다. 실제 Nile 지갑 주소·잔액, 현재 미리보기, 서명 상태와 온체인 결과는 각 단계에서 별도로 확인합니다. 브라우저를 닫은 상태의 백그라운드 거래·알림과 무인 실행 B-1/B-2는 이 승인형 흐름에 포함되지 않습니다.

`/api/health`와 `/api/capabilities`는 Mainnet 거래 미지원(`mainnetExecution:false`)과 Nile 시험 거래 코드 지원(`nileExperimentalExecution:true`)을 구분합니다. 지갑·체인 준비 상태는 서버에서 알 수 없어 `null`로 두고 매 동작마다 확인합니다. Mainnet USDT는 현재 UI에서 **가정 계산**이며 거래하지 않습니다. Nile jTRX는 별도 기술 시험입니다. 경제성 자료가 부족해도 계약·활성 시장·자산·계정·실제 예치 수수료가 검증된 경우에만 상세 위험 고지와 사용자님 확인 후 서명을 요청합니다. 이 경우 수익 권고로 표시하지 않습니다. 방송 수락은 성공으로 취급하지 않고 solidified 영수증과 동일 포지션 관측을 따로 확인합니다.

시연의 Mainnet 예시는 800 USDT를 30일 운용한다는 가정에서 `800 × ((1 + 0.05)^(30/365) − 1) ≈ 3.21 USDT`처럼 **비용 전 이자**만 계산합니다. 5%는 실측 금리가 아닙니다. 진입·환매 비용과 순이익은 미확인, Mainnet 실행 적격성은 `false`로 둡니다. Mainnet USDT 잔액 확인을 시연의 선행 조건으로 삼지 않으며, Nile 테스트 자산을 Mainnet 재원으로 취급하지 않습니다. Nile 첫 화면은 새 세션에서 100 TRX·7일 뒤 20 TRX 지출 예시를 사용합니다. 기존 저장 세션은 원 입력을 보존하고 `7일 뒤 20 TRX 예시 지출 적용` 버튼으로 예시를 선택할 수 있습니다. [시연 대본](docs/DEMO.md)에 두 사례의 순서를 적었습니다.

현재 환경의 네트워크·지갑·API 키 상태와 완료/미완료 증거는 [구현 상태](docs/IMPLEMENTATION_STATUS.md)에 기록합니다. **Nile TRX·jTRX 기술 왕복은 실증됐고, Nile PSM 실거래와 Mainnet 실행 가능 계획은 검증되지 않았습니다.**

## 자료

- [프로젝트 원계획](docs/PROJECT_PLAN.md)
- [상세 구현 계획](docs/IMPLEMENTATION_PLAN.md)
- [공식 출처](docs/SOURCES.md)
- [구현 상태](docs/IMPLEMENTATION_STATUS.md)
- [Nile 승인형 실증 증거](docs/NILE_A_EVIDENCE.md)
- [Nile PSM 구현·검증 계획](docs/NILE_PSM_EXECUTION.md)
- [시연](docs/DEMO.md)
