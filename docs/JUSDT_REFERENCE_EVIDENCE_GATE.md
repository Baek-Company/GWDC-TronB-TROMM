# Mainnet jUSDT 환매 비용 근거 게이트

현재 금액별 평가의 `readJusdtSizing`은 지갑·시장·가격·승인·예치 행동을 읽기 전용으로 조회합니다. 기존 jUSDT 보유량이 0으로 확인되지 않으면 평가를 보류합니다. 계정 모의 실행은 실제 거래 결과가 아니며, 거래 서명이나 전송을 수행하지 않습니다.

`redeemUnderlying(uint256)`은 미래 시점의 지갑 상태에서 실행됩니다. 현재 계정의 모의 실행이 실패하거나, 지금 성공해도 미래 비용과 출구 가능성을 증명하지 못합니다. 따라서 현재 어댑터는 `redeemModels: []`를 반환하고 회수 비용을 `unknown`으로 유지합니다. 이 상태의 묶음은 순익을 수치로 확정하거나 `conditional_allocate`로 승격할 수 없습니다.

## 과거 구현 확인 결과 (2026-09-29)

공식 TRON API의 과거 거래 본문과 확정 영수증은 당시 거래의 성공·Energy·이벤트를 보여주지만, 해당 시점의 프록시 구현 코드와 저장소 상태를 함께 증명하지 않습니다. [eth_getCode](https://developers.tron.network/reference/eth_getcode)와 [eth_getStorageAt](https://developers.tron.network/reference/eth_getstorageat)은 `latest`만 지원합니다. [eth_call](https://developers.tron.network/reference/eth_call)은 과거 블록 객체를 받아도 **최신 상태에서 실행**한다고 명시합니다. [triggerconstantcontract](https://developers.tron.network/reference/triggerconstantcontract) 역시 호출 시점의 노드 상태를 사용합니다. [getcontractinfo](https://developers.tron.network/reference/getcontractinfo)에는 과거 블록 선택 매개변수가 없습니다.

실제 Mainnet 읽기 전용 요청에서는 최신 코드가 확인되었지만, 과거 블록을 지정한 `eth_getCode`와 `eth_getStorageAt`은 모두 매개변수 오류 `-32602`를 반환했습니다. 과거 블록 객체를 넣은 `eth_call`의 비어 있지 않은 반환값은 최신 호출과 같았습니다. `getcontractinfo`에 비표준 과거 블록 필드를 추가한 요청도 현재 코드와 같은 코드를 반환했습니다. 이 확인 과정에서 지갑 키, 계약 주소, 코드, 거래 본문, 반환값은 출력하거나 저장하지 않았습니다.

현재 `marketCodeIdentity`는 jUSDT delegator 계약의 바이트코드 해시입니다. 프록시 구현이 별도로 바뀔 수 있으므로 이 해시만으로 실제 실행 코드의 과거·현재 동일성을 판단할 수 없습니다. 참조 영수증 모델을 연결할 때는 당시와 현재의 **구현 주소 및 구현 코드 해시**까지 대조하고, 추가 RPC가 필요해지면 평가 40회 예산도 다시 설계해야 합니다.

### A0 읽기 전용 재현 결과 (2026-09-29 14:27 UTC)

프로젝트의 서버 전용 TronGrid 설정을 사용해 Mainnet에 유한한 읽기 요청을 실행했습니다. 표에는 주소·코드·키·원시 응답을 저장하지 않았습니다. 비교 대상은 공식 [jUSDT 배포 목록](https://docs.justlend.org/developers/deployed_contracts/)의 구현 주소입니다.

| 읽기와 판정 | 결과 |
| --- | --- |
| `/wallet/getnowblock` 후 jUSDT `implementation()` 현재 호출 | 성공. 반환 구현 주소가 공식 배포 목록과 일치 |
| `/wallet/getcontract`로 현재 delegator와 현재 implementation 코드 확인 | 두 계약 모두 코드 존재 및 해시 계산 가능 |
| JSON-RPC `eth_getCode`에 관측 높이보다 100블록 전의 높이 지정 | `-32602` 매개변수 오류 |
| JSON-RPC `eth_getStorageAt`에 같은 과거 높이 지정 | `-32602` 매개변수 오류 |
| `eth_call`로 `implementation()`을 `latest`와 과거 블록 객체에서 각각 조회 | 양쪽 모두 비어 있지 않은 동일 반환값. 공식 API는 블록 존재를 확인한 뒤 **최신 상태에서 실행**하므로 이 일치는 과거 구현 동일성 증거가 아님 |

재현 절차는 현재 확정 여부와 별개로 최근 블록 높이 `N`을 `/wallet/getnowblock`에서 읽고, `N-100`을 16진수 블록 태그로 만들어 위 JSON-RPC 메서드에 전달하는 것입니다. 블록 객체는 `{ "blockNumber": "0x…" }` 형식입니다. 현재 구현 주소는 `implementation()`의 ABI 반환값을 TRON 주소로 해석하고, 그 주소와 jUSDT delegator 각각의 `/wallet/getcontract` 코드를 별도로 확인합니다. [TRON `eth_getCode`](https://developers.tron.network/reference/eth_getcode), [`eth_getStorageAt`](https://developers.tron.network/reference/eth_getstorageat), [`eth_call`](https://developers.tron.network/reference/eth_call)

**A0 판정: `evidence_unavailable` (현재 프로젝트가 사용할 수 있는 Mainnet RPC 경로).** 이번 조회로 현재 구현은 확인했지만, 후보 환매 거래의 실행 직전 구현 주소·코드 해시를 독립적으로 재현한 사례가 없습니다. 공식 [CErc20Delegator 소스](https://github.com/justlend/justlend-protocol/blob/main/contracts/CErc20Delegator.sol)에는 구현 변경 이벤트를 내는 `_setImplementation` 외에도 구현 코드로 실행을 위임하는 공개 경로가 있습니다. 따라서 인덱스에서 `NewImplementation` 이벤트가 안 보인다는 사실만으로 저장소의 구현 포인터가 변하지 않았다고 단정할 수 없습니다. 전체 거래 순서·실제 배포 바이트코드의 쓰기 경로까지 검증하는 별도 역사 재생 또는 누락 없는 지속 관측 증명이 확보되기 전에는 A1 수집기와 A2 모델 연결을 시작하지 않습니다. `redeemModels: []`, 왕복 순익 미확인, 신규 예치 보류를 유지합니다. 이 판정은 모든 가능한 아카이브·독립 검증 서비스가 영원히 불가능하다는 주장이 아니라, **현재 증거 경로의 미충족**입니다.

[TronGrid 계약 이벤트 API](https://developers.tron.network/reference/get-events-by-contract-address)는 확인된 이벤트를 페이지 단위로 조회할 수 있지만, [TronGrid 안내](https://developers.tron.network/docs/trongrid)는 이를 합의 상태가 아닌 인덱스 서비스로 구분합니다. 이벤트가 검색되지 않았다는 사실만으로 과거부터 현재까지 구현 변경이 없었다고 증명할 수 없습니다. 현재 계획의 최대 2페이지·20건 조회 예산으로는 프록시의 배포 이후 모든 변경 경로도 검증할 수 없습니다. 따라서 과거 구현 식별자를 현재 코드 해시로 복사해 참조 비용 모델을 만들지 않습니다.

참조 비용 모델을 사용하려면 `server/data/jusdt-reference-model.ts`의 검증기에 아래 증거를 모두 전달하는 별도 읽기 수집기가 필요합니다.

1. 최대 30일 이내의 **확정된 Mainnet 거래**에서 전체 거래 본문과 영수증을 함께 확보합니다. 거래 ID, 성공 결과, ABI 함수·매개변수·이벤트·반환 코드를 서로 대조합니다.
2. 각 거래 시점의 실제 계약 구현 코드와 현재 구현 코드가 같았다는 **독립적으로 검증 가능한 과거 상태 증거**를 확보합니다. 예를 들어 신뢰 가능한 과거 상태 스냅샷과 완전한 변경 경로 검증, 또는 검증 가능한 체인 재실행 결과가 필요합니다. 프록시의 현재 코드나 일부 업그레이드 이벤트만 같다는 사실로 과거 구현 동일성을 추정하지 않습니다.
3. 같은 행동·계약·구현에 대해 서로 다른 성공 거래 ID 5개 이상과 서명된 거래 바이트 크기·Energy 사용량을 검증합니다. 대상 금액의 절반~두 배 구간 밖의 표본은 사용하지 않습니다.
4. 조회 예산과 10분 모델 만료를 지킵니다. 증거가 없거나 갱신에 실패하면 이전 모델을 연장하지 않고 `unknown`을 반환합니다.

참조 모델이 추가되더라도 결과는 **현재 조건의 비용 시나리오**이며, 미래 환매 성공이나 수수료를 보증하지 않습니다. 실제 거래 권한은 별도 지갑 승인과 정책 검증이 필요합니다.
