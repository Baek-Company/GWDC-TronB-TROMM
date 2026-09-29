<div align="center">

# GWDC 2026 · TRON Challenge B

**AI-Assisted TRON Asset Planning Prototype**

*"언제 돈이 필요한가?"라는 질문에서 시작하는 날짜 기반 자산 배분 플래너*

![Node.js](https://img.shields.io/badge/Node.js-≥20-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow)

</div>

---

## 📖 Overview

GWDC는 TRON 블록체인 위에서 동작하는 **AI 기반 자산 배분 프로토타입**입니다.

사용자의 잔고·예정 지출·비상 자금·투자 기한·위험 선호도를 수집하여, 날짜별 버킷으로 나눈 뒤 **jUSDT (JustLend)**, **jUSDD (USDD PSM → JustLend)**, **TRX Stake 2.0 (SR Voting)** 세 가지 경로 중 순수익이 가장 높은 배분을 추천합니다.

> LLM은 사용자 입력을 파싱하고 결과를 설명하는 역할만 수행합니다.
> 수익 계산·배분 결정·트랜잭션 생성·서명은 LLM이 하지 않습니다.

## ✨ Key Features

| 기능 | 설명 |
|------|------|
| **날짜별 유동성 래더** | 예정 지출·비상 자금·최종 잔고를 각각 독립적으로 평가 |
| **3-경로 배분 탐색** | jUSDT, jUSDD, TRX Stake 2.0 간 다중 시작점 수치 탐색으로 최적 배분 도출 |
| **순수익 기반 판단** | 진입·출금·PSM 변환·네트워크 수수료를 포함한 실질 수익으로 비교 |
| **출금 사전 준비** | 사용일 2일 전부터 출금 준비 시작, Stake 2.0은 언프리즈 딜레이 + 1일 버퍼 확인 |
| **변환 인식 스테이킹** | SunSwap V2 풀 스냅샷 기반 USDT ↔ TRX 변환 비용 포함 |
| **안전장치** | 데이터 불가·음수 수익·유동성 부족·USDD 리스크 거부 시 → Hold로 전환 |
| **실시간 재평가** | 5분 주기로 플랜을 재검증하여 유지/검토/일시정지 제안 |
| **한국어 대화 입력** | 자연어로 요구사항 입력 가능 (폼 입력도 지원) |

## 🔄 User Flow

```
1. 한국어 대화 또는 폼으로 요구사항 입력
2. 추출된 요구사항 확인
3. 날짜별 배분 및 출금/언스테이크 일정 검토
4. 추천 플랜의 모니터링 시작
5. 시세 변동 또는 지출 일정 변경 시 재평가
```

## 🛠 Tech Stack

| 영역 | 기술 |
|------|------|
| **Frontend** | React 19, Vite 8, TypeScript |
| **Backend** | Express 5, Node.js ≥ 20 |
| **Blockchain** | TronWeb 6, TronGrid API |
| **AI / LLM** | NVIDIA NIM (OpenAI-compatible) |
| **Protocol** | MCP (Model Context Protocol) SDK |
| **Validation** | Zod, Decimal.js |
| **Testing** | Vitest |

## 📁 Project Structure

```
GWDC/
├── index.html                  # Vite 진입점
├── package.json
├── vite.config.ts
├── tsconfig.json
├── .env.example                # 환경변수 템플릿
│
├── shared/                     # 프론트·서버 공유 비즈니스 로직
│   ├── schemas.ts              #   API 계약 정의 (Zod)
│   ├── needs.ts                #   입력 검증 & 날짜 처리
│   ├── planning.ts             #   A/B/C/hold 기준선 & 추천
│   ├── ladder.ts               #   3-경로 날짜별 배분 탐색
│   ├── monitor.ts              #   유지/검토/일시정지 판정
│   ├── eligibility.ts          #   상품 적격 판정
│   ├── funding.ts              #   자금 조달 로직
│   └── units.ts                #   단위 변환
│
├── server/                     # Express API 서버
│   ├── index.ts                #   API 라우트 & 서버 설정
│   ├── env.ts                  #   환경변수 파싱
│   ├── doctor.ts               #   설정 검증 도구
│   ├── data/                   #   TRON 데이터 리더
│   │   ├── justlend.ts         #     JustLend 시세 & 포지션
│   │   ├── quotes.ts           #     상품 시세 수집
│   │   ├── staking.ts          #     TRX Stake 2.0 데이터
│   │   ├── swap.ts             #     SunSwap V2 풀
│   │   ├── tron-rpc.ts         #     TRON RPC 클라이언트
│   │   └── usdd.ts             #     USDD PSM 데이터
│   ├── llm/                    #   LLM 통합
│   │   ├── nim.ts              #     NVIDIA NIM 어댑터
│   │   ├── provider.ts         #     LLM 프로바이더 추상화
│   │   └── template.ts         #     폴백 템플릿
│   └── mcp/                    #   MCP 클라이언트
│       ├── clients.ts          #     MCP 클라이언트 관리
│       └── registry.ts         #     도구 레지스트리
│
├── src/                        # React 프론트엔드
│   ├── App.tsx                 #   메인 앱 컴포넌트
│   ├── main.tsx                #   React 진입점
│   ├── styles.css              #   글로벌 스타일
│   ├── features/               #   기능별 UI 컴포넌트
│   │   ├── common.tsx          #     공통 UI 컴포넌트
│   │   ├── conversation/       #     대화 입력 UI
│   │   ├── execution/          #     Nile 테스트넷 실행
│   │   ├── market/             #     시장 데이터 표시
│   │   ├── monitor/            #     플랜 모니터링
│   │   ├── overview/           #     개요 화면
│   │   ├── plans/              #     플랜 비교
│   │   └── review/             #     검토 화면
│   └── lib/                    #   유틸리티
│       ├── api.ts              #     API 클라이언트
│       ├── storage.ts          #     로컬 스토리지
│       └── tronlink.ts         #     TronLink 연동
│
├── tests/                      # 테스트
│   ├── ladder.test.ts          #   배분 탐색 테스트
│   ├── planning.test.ts        #   플래닝 테스트
│   ├── monitor.test.ts         #   모니터링 테스트
│   └── llm-and-mcp.test.ts    #   LLM & MCP 테스트
│
├── fixtures/                   # 테스트용 데이터
│   ├── demo-needs.json
│   └── synthetic-quotes.json
│
└── scripts/                    # 실행 스크립트
    └── run                     #   dev | test | build | doctor | typecheck
```

## 🚀 Getting Started

### Prerequisites

- **Node.js** ≥ 20
- **pnpm** (권장) 또는 npm

### Installation

```bash
# 1. 리포지토리 클론
git clone https://github.com/<your-username>/GWDC.git
cd GWDC

# 2. 의존성 설치
pnpm install          # 또는 npm install

# 3. 환경변수 설정
cp .env.example .env.local
# .env.local 파일을 열어 필요한 키 입력
```

### Run

```bash
# 개발 서버 시작 (API + Web 동시)
sh scripts/run dev

# http://127.0.0.1:5173/ 에서 확인
```

### Other Commands

```bash
sh scripts/run typecheck    # TypeScript 타입 검사
sh scripts/run test         # Vitest 테스트 실행
sh scripts/run build        # 프로덕션 빌드
sh scripts/run doctor       # 설정 검증
```

## ⚙️ Environment Variables

`.env.example`을 `.env.local`로 복사한 뒤 값을 입력하세요. **`.env.local`은 절대 커밋하지 마세요.**

| 변수 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `DATA_MODE` | ✅ | `synthetic` | 데이터 모드 (`synthetic` / `live`) |
| `API_PORT` | | `8787` | API 서버 포트 |
| `LLM_PROVIDER` | | `nim` | LLM 프로바이더 |
| `NIM_BASE_URL` | | `https://integrate.api.nvidia.com/v1` | NIM API 엔드포인트 |
| `NIM_API_KEY` | | – | NVIDIA NIM API 키 |
| `NIM_MODEL` | | `openai/gpt-oss-20b` | 사용할 NIM 모델 |
| `LLM_TIMEOUT_MS` | | `45000` | LLM 요청 타임아웃 (ms) |
| `TRONGRID_API_KEY` | | – | TronGrid API 키 |
| `MCP_TRONGRID_ENABLED` | | `false` | MCP TronGrid 활성화 여부 |
| `ENABLE_NILE_EXECUTION` | | `false` | Nile 테스트넷 실행 활성화 |

> **Note**: `DATA_MODE=synthetic`이 기본 데모 모드입니다. `live`로 변경 시 데이터 소스가 설정되어 있어야 하며, 서버를 재시작해야 합니다.

## ⚠️ Scope & Limitations

- **읽기 전용 분석**: Mainnet 트랜잭션을 생성·서명·브로드캐스트하지 않습니다.
- **스냅샷 기반**: 수익률은 현재 시점의 금리·유동성·비용 스냅샷 기반이며, 보장된 수익이 아닙니다.
- **인센티브 제외**: 독립적으로 검증되지 않은 보상은 계산에서 제외됩니다.
- **안전 정책**: 2일 출금 준비 기간과 1일 스테이크 액션 버퍼는 프로토콜 보장이 아닌 제품 안전 정책입니다.
- **가격 변동 미반영**: 스테이킹 경로는 현재 SunSwap 풀 가격이 계획된 출구까지 유지된다고 가정합니다.
- **USDT 기반 최적화**: 옵티마이저는 변환된 USDT 예산 위에서 작동하며, 원본 TRX의 직접 스테이킹은 모델링하지 않습니다.
- **Nile 테스트넷**: 개발 전용 트랜잭션 테스트 환경으로만 사용됩니다.

## 📄 License

This project is licensed under the [MIT License](LICENSE).
