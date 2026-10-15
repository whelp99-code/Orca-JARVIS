# 회사 후보 owner 모델 불일치 해결 설계

TASK-COMPANY-OWNER-MODEL-DESIGN-20261015  
attempt=9eaf3e68-6614-45a4-a3d1-5a8f33d65b61

보완: TASK-COMPANY-OWNER-DESIGN-REV-20261015,
attempt=390e08aa-ef6c-443c-8793-5b00f265a37e.
가재·나희의 `3297452` 검토와 운영자 관리 설정 합의안을 반영했다.
추가로 `86a4c4e`의 나희·가재 검토 세 항목과 Codex P2 두 항목을 반영했다.
**대표 결정(10/15 09:23:05 KST (Slack C0C6HJM0BV5:1792023785.146919, "오모냥아 진행해"), 진행): 키 교체 시 회사 승인함 일시 중지 수용, 재개 절차는 오모냥 담당 별도 과제**다.

**추천: B — 기존 후보의 데이터 owner는 보존하고, 정책에 고정된
`approver_principal_id`를 별도로 두어 대표 결정 권한을 묶는다.**
후보 자체를 재소유시키지 않는다. 현재 구현 목표는 **새 revision의 최초 등록**이다.
활성화 직전에 기존 v1 handoff/outbox·회사 enrollment·JARVIS 수입 기록이 하나라도
있으면 거절하고 멈춘다. 그런 기록을 옮기는 장치는 별도 승인된 후속 과제다.
신뢰 기준은 기존 운영자 관리 설정이며 새 정책 서명 ceremony를 만들지 않는다.
단순 config 변경이나 DB UPDATE만으로 해결하지 않는다.
이 문서는 분석·설계만이다. 아래 새 필드·protocol·이행은 모두 **제안/미구현**이며,
코드·운영 DB·키·설정·서비스 변경과 owner 서명은 수행하지 않았다.

## 1. 근거, 범위와 현재 상태

- JARVIS main: `96702e1ab193ef20148b154ef73f8d8b52be6b29`.
- SB master: `6bb4baf41263f0ead726f902e4a8fad6e2225023`.
- 두 remote ref를 읽기 전용으로 확인했다. 로컬 lane HEAD854ae/7ae를
  이 설계의 코드 버전이라고 대신 사용하지 않았다.
- 사용자가 제공한 `/tmp/gajae-owner.txt` 전체 분석을 출발점으로 사용했다.
  저장소 전체 owner 조사/운영 조사/별도 SB explore를 반복하지 않았다.
  누락된 계약·enrollment·scope 인용만 지정된 세 파일에서 좁게 보완했다.
- 선행 준비 문서:
  `/home/jm/.local/state/omonyang/company-handoff-prep-0105-20261015.md`.
  그 실제 snapshot은 `2026-10-14T22:44:31.620Z`, 후보 27건 모두 candidate,
  owner `principal:mail-ms`, workspace
  `75c2b088-e5aa-5396-9e9e-6dfd77e50048`,
  project:company / policy:mail-ms-receive-v1 / deletion0·empty digest였다.
  handoff 테이블은 없었고 01~05에서 enrollment/import를 하지 않았다.
- 보완 입력은 `/tmp/gajae-owner-review.txt`, `/tmp/nahee-owner-review.txt`,
  `/tmp/gajae-owner-scope.txt`, `/tmp/gajae-nahee-merge.txt` 전체다.
  최초 승인자는 기존 운영자 신뢰 경계에서 확정하고 이행 구현은 현재 필요한
  범위로 줄이라는 합의를 기준으로 한다. 이번에도 운영 DB는 다시 조사하지 않았다.
- 추가 보완 입력은 `/tmp/nahee-88b.txt`, `/tmp/gajae-88b.txt` 전체다.
- Codex P2 원문은 PR #88의 [version 불변 trigger](https://github.com/whelp99-code/Orca-JARVIS/pull/88#discussion_r4277639200)와
  [과거 v1 inbox](https://github.com/whelp99-code/Orca-JARVIS/pull/88#discussion_r4277639202)다.
  `gh api repos/whelp99-code/Orca-JARVIS/pulls/88/comments`로 원문을 확인했다.
- 후속 [accept receipt 권한 조회](https://github.com/whelp99-code/Orca-JARVIS/pull/88#discussion_r4277775413)와
  [completion verifier v2 경계](https://github.com/whelp99-code/Orca-JARVIS/pull/88#discussion_r4277775420)도 원문 전체를 확인했다.
- 요청의 “기존 24건”은 보존해야 할 기존 집합이다. 위 27건과 같은 시점의
  건수로 단정하지 않는다. 향후 실행은 cohort manifest와 당시 전건 N을
  보존해야 하며 24 또는 27을 SQL LIMIT나 이행 완료 상수로 사용하지 않는다.
  이 문서 작성을 위해 운영 DB를 다시 읽지 않았다.

여기서 owner 판단은 **회사 후보의 데이터 접근 owner와 결정 signer를 연결하는
전체 경로**를 뜻한다. OS UID/파일 소유권, 별개의 개인 memory owner를
대표 승인 권한으로 오인하지 않는다. 그 경계는 이 문제의 우회 수단이 아니다.

## 2. 현재 owner 판단 지점 — 파일:행

JARVIS 경로는 아래 SHA에 고정한다:
`https://github.com/whelp99-code/Orca-JARVIS/tree/96702e1ab193ef20148b154ef73f8d8b52be6b29`.
SB 경로는 아래 SHA에 고정한다:
`https://github.com/whelp99-code/second-brain-app/tree/6bb4baf41263f0ead726f902e4a8fad6e2225023`.

| 저장소/지점 | 현재 판단과 결과 | 설계상 의미 |
|---|---|---|
| JARVIS `src/control-plane.ts:62` | 회사 결정 signer가 args.owner와 같고 processor와 달라야 함 | 데이터 소유와 인간 결정 권한을 현재 한 축으로 결합 |
| JARVIS `src/company-candidate-execution.ts:139` | receipt signer 및 trusted key principal 모두 command.args.owner와 일치해야 함 | signature 문자열만 바꿔도 registry principal 검사에서 거부 |
| JARVIS `src/company-candidate-execution.ts:217` | 후속 완료 경로에서도 결정 key/principal 바인딩 재확인 | accept만 고치고 완료 검사를 남기면 불완전 |
| JARVIS `src/company-candidate-contract.ts:17-25` | owner 필수, owner != processor; strict args | 현재 approver 필드는 없고 추가 config만으로 허용되지 않음 |
| JARVIS `src/company-candidate-contract.ts:52-55` | target+args canonical bytes를 domain과 함께 handoff key에 hash | approver 추가 시 기존 식별값/receipt 재사용 불가 |
| JARVIS `src/company-candidate-contract.ts:58-68`, 특히65 | requested_by == args.owner, nonce/request ID/generation/TTL 검사 | B에서도 요청 주체와 데이터 owner 검사를 유지; signer와는 분리 |
| JARVIS `src/company-candidate-contract.ts:72-86` | 재계산 key/digest 및 action args를 각각 검증 | importer와 staging parser도 동시에 새 계약으로 맞춰야 함 |
| JARVIS `src/control-command-stage.ts:18,55-61` | 공통 stage는 schema_version 1만 허용하고 INSERT에 명령 version을 저장하지 않음 | 회사 명령2는 공통 stage/type 및 version 저장도 함께 바꿔야 함 |
| JARVIS `src/control-command-read.ts:38` | decodeStoredControlCommand가 항상 schema_version 1로 복원 | 회사2를 저장해도 읽을 때1로 바꾸면 digest 왕복이 깨짐 |
| JARVIS `migrations/021_approval_control_plane.sql:69` | control_request_identity_immutable은 BEFORE UPDATE OF에 기존 identity 열을 나열 | 새 version 열은 자동 보호되지 않으므로 새 migration에서 trigger DROP/CREATE 필요 |
| JARVIS `src/owner-inbox.ts:327-329` | itemOf가 args_json을 companyArgumentsSchema로 버전 구분 없이 parse | 새 필드 required인2 schema만 쓰면 과거1 inbox 조회가 throw; 저장 version별 schema/표시 타입 필요 |
| JARVIS `src/control-plane-contract.ts:7-26` | ControlCommandRequestInput.schema_version은 literal1, StoredControlCommand가 그 타입을 계승 | action별 회사2/기타1 구별과 digest 입력 타입 변경 필요 |
| SB `sb/company_memory_handoff.py:65-68` | policy는 processor ID/keys와 owner_approval_keys만 보유 | 명시적 approver principal은 현재 없음 |
| SB `sb/company_memory_handoff.py:99-106` | ControlArguments.owner/project/policy/fence/processor/operations | data scope는 보존하고 새 승인 축을 별도로 계약화 |
| SB `sb/company_memory_handoff.py:123-145`, 특히130·144 | enrollment context에 owner=context.principal, 조회 결과와 exact equality | config owner/새 approver만 바꾸면 등록 context와 불일치 |
| SB `sb/company_memory_handoff.py:157-167`, 특히158 | owner를 candidate.access.owner에서 생성; target+args를 hash | DB 후보 owner를 caller가 임의로 대체할 수 없음 |
| SB `sb/company_memory_handoff.py:175-197` | 기존 identity 다르면177-178 conflict; 미만료면179-191 같은 bytes 반환; 이미 결정됐으면196-197 거부 | gajae의 “179행 conflict”를 좁게 확인하면 실제 identity 거부는177-178 |
| SB `sb/company_memory_handoff.py:208-215` | 같은 candidate PK의 generation/command만 갱신 | 이 동작은 같은 identity의 만료 갱신이지 정책 변경·supersede 기능이 아님 |
| SB `sb/company_memory_handoff.py:228-253`, 특히243-248 | 등록 확인 뒤 command.owner/project/policy/fence가 candidate 및 policy와 같은지 확인 | B가 signer 비교를 바꿔도 데이터 접근 검사는 제거하면 안 됨 |
| SB `sb/company_memory_handoff.py:261-282`, 특히270 | mark_processed는 저장된 approve receipt; signer == context.principal, key·signature·request/digest·decision 검증 | 대표 principal:owner는 현재 principal:mail-ms와 달라 거부 |
| SB `sb/company_memory_handoff.py:283-292` | 원래 approval bytes와 request reuse 검사 | 정책 변경 후 과거 receipt를 새 digest에 옮기지 못함 |
| SB `sb/company_memory.py:209-225`, 특히217·224-225 | access.owner가 immutable tuple에 포함되고 기존 값과 다르면 MEMORY_CANDIDATE_CONFLICT | 후보 owner 자리 재작성은 현재 계약에 없음 |
| SB `sb/company_memory.py:82-89`, 특히84 | access.owner == current.owner 및 policy/projects 범위 검사 | config owner만 바꾸면 기존 후보가 scope에서 빠짐 |

JARVIS signer 검사 인용은 사용자 제공 조사에 근거한다. memory.py의 두 판단
행도 해당 지점만 조회해 보완했다.
보완한 SB handoff 파일 blob은 `ac3fbb759caafb81ec9ba4b171c1b444d0637e0b`다.
SB 등록의 재호출 `ON CONFLICT DO NOTHING` 제약은 제공 분석에 근거한다.
새 context를 기존 행에 자동 덮어쓰는 실제 API가 있다고 가정하지 않는다.

signer principal은 `trusted_authority_keys.principal_id`가 정한다.
선행 공개 registry 결과에서 대표 key `owner-decision-v1`은 principal:owner /
decision / Ed25519였다. principal:mail-ms로 주장하도록 receipt를 바꾸는 것도,
대표 key를 그 서비스 principal로 재등록하는 것도 권한 모델 해결이 아니다.

### 2.1 반드시 함께 바꿀 다섯 검사

행 번호는 위 소스 SHA 기준이며 오른쪽은 **후속 구현 조건**이다.
`fixed`는 JARVIS의 운영자 관리 정책/키 등록에서 유도해 회사 enrollment에
고정한 binding이다. 요청 args나 수입 receipt에서 권한을 만들어 내지 않는다.

| 번호 | 현재 코드 지점 | 바뀐 뒤 통과 조건 |
|---|---|---|
| C1 | JARVIS `src/control-plane.ts:62` (`ControlPlane.decide`) | 회사 action만 receipt signer와 조회 key principal == fixed approver; signer != processor 유지. command approver·binding version/digest 및 receipt key ID·decision 용도·실제 DER-SPKI 지문을 fixed pin과 **receipt 저장/상태 변경 전** 대조. C2로 미루지 않음 |
| C2 | JARVIS `src/company-candidate-execution.ts:139` | `approval.signer_principal_id`와 조회 key의 `principal_id` **둘 다** fixed approver와 같음. key ID·decision 용도·공개키 지문도 등록 pin과 일치 |
| C3 | JARVIS `src/company-candidate-execution.ts:217` (`assertNotRevoked`) | 현재 key principal == fixed approver, purpose에 decision 포함, 지문 == 등록 pin; 현재 정책/version/binding과 key/request/receipt/principal 폐기를 매 호출마다 확인 |
| C4 | SB `sb/company_memory_handoff.py:270` (`authorize_transition`) | signer == SB의 고정 policy.approver_principal_id, key ID와 실제 공개키 지문은 고정 대표 목록에 있음. `require_enrollment`와 현재 binding 일치가 선행. accept/reject와 저장된 approve receipt를 쓰는 mark_processed 모두 적용 |
| C5 | JARVIS `src/company-candidate-contract.ts:25` | owner != processor 유지, approver != owner와 approver != processor 추가. required approver/binding 필드는 strict 새 계약으로 검증; parser만으로 인가하지 않고 C1~C3 fixed 대조도 필수 |

`src/company-candidate-contract.ts:65`의 `requested_by == args.owner`는 유지한다.
SB의 candidate owner/project/policy/deletion scope 검사도 유지한다.
SB `owner_approval_keys`는 **key ID -> 공개키**이며 principal 레지스트리가 아니다.
SB에서 JARVIS처럼 `key.principal_id`를 검사한다고 쓰면 안 된다.
SB는 실제 서명의 signer 필드와 대표 전용 공개키 pin을 함께 확인한다.
`ControlPlane.decide`는 approve와 reject 모두에서 C1의 고정 key 대조 및 기존
서명·시간·폐기 검증이 끝나기 전에 receipt를 저장하거나 pending 상태를 바꾸지 않는다.
같은 principal:owner의 유효한 decision key라도 회사 목록 밖이면 거절한다.
실패 시 요청은 pending 그대로, receipt·이벤트는 생성 0, 상환은 불변이며 실제
pinned key로 같은 요청의 후속 결정이 가능해야 한다(T17).
기존 SB `sb/company_memory_cli.py:248-256`의
`COMPANY_HANDOFF_KEYS_NOT_SEPARATE`는 `public_bytes_raw()` 집합끼리 대조해
대표/Mail/processor **공개키 바이트 중복만** 거부한다. 이 검사는 유지한다.
key ID 집합 충돌 거절은 **새로 추가할 동작**이다. 현재 코드에 있다고 주장하지 않는다.
서로 다른 키가 같은 ID를 써도 새 검사에서 거절해야 하며 T3으로 증명한다.

## 3. 세 안 비교

### A. 데이터 owner를 대표/회사 principal로 정본화하고 writer를 분리

**모델:** 신규 후보 access.owner를 principal:owner로 하고 Mail의
principal:mail-ms는 인증된 작성자/source provenance로 별도 기록한다.
principal:owner는 이 설치의 대표 승인 principal이지 전 회사에 공통인 조직 ID가 아니다.

| 차원 | 평가 |
|---|---|
| 보안: 누가 무엇을 승인 | 기존 signer==owner를 유지해 대표가 새 owner 범위의 후보를 승인. Mail은 receive-only와 별도의 작성자 증거만 가져야 함. owner 필드를 receiver가 선택하게 두면 다른 회사 owner로 주입 가능하므로 입력 경계·key scope도 바꿔야 함 |
| 24/N 보존·이행 | 기존 행을 자리 UPDATE할 수 없음. 원본·후속 owner projection·명시적 1:1 mapping과 provenance, 과거 권리의 해석을 설계해야 함. candidate/source IDs·본문 digest·terminal state·삭제 fence·과거 receipts를 보존; 동일 원본 재수집 중복 문제도 해결 |
| 코드 범위 | SB 후보 생성/receive identity/access scope/저장 conflict·reader/export, Mail producer의 owner와 author 계약, 등록 context, JARVIS import·digest·scope·이행 맵. 작성자 저장 방식은 새 설계가 필요하고 현재 필드가 있다고 주장하지 않음 |
| 시험 | 신규 owner와 writer 구별, Mail의 타 owner 주입 거부, 24/27/N 전체 mapping·digest·중복·권리 보존, 구 receipt 거부, reader/personal isolation, 생성과 이행의 동시성 |
| 되돌리기 | 신규 projection 사용·결정 전에는 배치 활성화만 취소. 새로운 승인/처리/삭제가 생긴 뒤 owner를 원래 값으로 UPDATE하면 안 됨. dual lineage 유지 후 전진형 이행 또는 검증된 전체 호환 복구 필요 |

**판단:** 조직 데이터 owner를 재정의하려는 장기 사업 요구에는 가능하지만,
이 승인함 오류만 고치기에는 넓다. 데이터 접근 owner와 인간 approver를 또 결합하고,
이미 보존해야 하는 후보의 identity/scope 이행 비용을 만든다.

### B. 데이터 owner는 유지하고 정책에 고정된 승인권자 분리 — 추천

**모델:** access.owner=principal:mail-ms를 그대로 두고, 해당 provider/workspace의
승인 권한만 `approver_principal_id=principal:owner`로 고정한다.
이는 임의 체인 위임이 아니라 한 company scope에 대한 단일 대표 결정 binding이다.

| 차원 | 평가 |
|---|---|
| 보안: 누가 무엇을 승인 | 기존 trusted decision key와 고정 승인 policy에 부합하는 대표만 그 scope의 accept/reject 및 검증된 후속 완료를 승인. receiver/handoff와 processor는 여전히 결정 불가. runtime caller가 approver를 고르거나 owner와 signer 비교를 통째로 삭제하는 안은 금지 |
| 24/N 보존·이행 | 후보 행·access.owner·source/content digest·state 그대로. 현재는 최초 등록만; legacy 기록 하나라도 있으면 활성화 거절. 후보 owner UPDATE와 source access policy_revision 재작성 없음 |
| 코드 범위 | 양쪽 policy/context/strict 새 arguments/digest 계약, C1~C5, key pin·현재 binding 재확인, importer/transport, 최초 등록·monotone version·활성화 gate. legacy mapping/outbox PK 재설계/두 DB 전환 engine 제외 |
| 시험 | 대표 허용, 모든 비대표·key/digest/policy 위조 거부, same-ID key 교체·옛 policy 복원 거부, candidate 불변, activation 직전 legacy 기록/동시 유입 거부, 단계별 재확인·만료 후 동일 완료 재시도 |
| 되돌리기 | 효과 전 신규 활성화 정지, 후보 불변. 새 등록/상환 뒤 구 설정·구 바이너리만 덮어쓰기 금지; 등록 증거/최고 version 보존, incompatible downgrade 거절. legacy 전환 자체는 이 PR에서 제공하지 않음 |

**조건:** 설정 한 줄은 현재 strict parser에도, signer/key principal 검사에도
맞지 않는다. 반드시 양쪽 코드·서명에 묶인 digest·등록 policy를 함께 바꿔야 한다.
대표의 key ID를 서비스 principal에 재매핑하지 않는다.

**B의 비추천 변형:** 임의 delegation chain 또는 요청마다 다른 approver 지정.
이 경우 Mail/processor credential을 탈취한 호출자가 새로운 승인자를 끼워넣을 수 있고,
위임 깊이·scope·expiry·revocation·key purpose까지 별도 프로토콜이 필요하다.
현재 단일 대표 요구에 그 상설 권한 확대는 불필요하다.

### C. 기존 후보를 감사 원장으로 명시적 재소유 이행

**모델:** legacy 데이터는 불변으로 남기고 승인된 1회 batch manifest를 통해
새 owner의 successor 후보/권리 projection과 mapping을 만든다. A의 이행 수단이며
B를 구현하지 않고 C만으로 승인자 불일치를 해결할 수는 없다.

| 차원 | 평가 |
|---|---|
| 보안: 누가 무엇을 승인 | 정본 데이터 권리를 옮기는 1회 관리자 capability가 필요. 기존 receive/enrollment/processor 키로 무제한 소유권 변경을 허용하면 안 됨. 이행 권한과 개별 후보 승인 권한을 분리하고 대표·데이터 권리 근거를 명시 |
| 24/N 보존·이행 | 원본 삭제·자리 갱신 금지. 전체 snapshot+manifest+old/new IDs·digests·state·policy/fence·source refs mapping, coverage/uniqueness/rights 검증, 이후 유입 cohort 따로 처리. 이전 receipt는 이전 digest에 남음 |
| 코드 범위 | SB migration engine/schema/audit/duplicate source resolution·reader·delete propagation, producer·JARVIS lineage/command invalidation, enrollment·signed migration manifest. 제공 코드에 이 기능이 있다는 뜻이 아님 |
| 시험 | 24/27/0/N, 누락/중복 mapping, 악의적 scope 확대, partial crash/restart, candidate ID 충돌, concurrent receive/deletion, old/new digest replay, processed/rejected terminal preservation |
| 되돌리기 | successor 활성화·효과 실행 전에는 미완료 batch 취소 가능. 이후는 양 lineage의 사실/삭제를 보존한 전진 이행; 원본 테이블만 backup으로 덮어써 완료/삭제를 부활시키면 안 됨 |

**판단:** 법적 조직 owner 정본화 요구가 생기면 별도 과제로 검토한다.
이번 요구에는 데이터 권리 이행을 피하는 B가 작고 명확하다.
C의 append-only 감사 원칙은 유지하지만 현재 B 구현에 legacy 이행 engine을 넣지 않는다.

## 4. 추천 B의 구체적인 권한 모델

| 축 | 값/근거 | 유지할 권한 |
|---|---|---|
| 데이터 owner | 기존 candidate.access.owner / principal:mail-ms | 기존 owner/project/access policy/deletion scope |
| 작성·요청 주체 | 인증된 Mail/ordinary authority key와 source provenance | 수신/등록/명시적 handoff만, 인간 결정 금지 |
| approver | 정책에 고정된 principal:owner + purpose decision의 허용 key IDs | policy scope 안의 대표 approve/reject |
| processor | 별도 principal:company-candidate-processor + 별도 material | 실제 대표 receipt를 전달하고 검증된 완료만 수행 |

최소 변경은 운영자 관리 CompanyHandoffPolicy/JARVIS 키 등록과 enrolled binding에
승인자·키 pin·승인 정책 버전을 고정하고 새 ControlArguments에 검증용 복사본을 넣는다.
명령에 실린 값은 **권한 원본이 아니다**. 아래 `command.approver`는 새
`args.approver_principal_id`의 약칭이다.
검사 순서는 다음 **설계 불변식**을 만족해야 한다:

```text
command.owner == candidate.access.owner                      [데이터 경계 유지]
command.approver == fixed_enrolled_policy.approver             [caller 선택 금지]
receipt.signer_principal == fixed_enrolled_policy.approver
JARVIS.trusted_decision_key.principal == fixed_enrolled_policy.approver
receipt.key_id in pinned_approver_key_set
actual_public_key_fingerprint == pinned_fingerprint
JARVIS.current_key_purpose includes decision; binding.purpose == decision
command.approval_policy_version == enrolled_version == current_policy_version
command.approval_binding_digest == enrolled_digest == current_binding_digest
approver != owner; approver != processor; approver != authenticated_handoff_principal
signature + exact command/request digest + purpose + revocation
+ expiry/not_before + one-use/redemption + project/deletion fences [기존 유지]
```

소스의 requested_by==owner 검사를 approver==requested_by로 바꾸지 않는다.
요청자/데이터 주체와 승인자는 원래 다르다. 다른 개인·daily/control action의
owner guard를 전역적으로 약화시키지 않고 company action 분기만 바꾼다.
단순히 “decision purpose인 아무 key”를 허용하지 않는다. 기존 jm-owner root도
principal:owner binding의 허용 대표 key와 같다고 간주하지 않는다.

### 4.1 최초 승인자 확정: 기존 운영자 관리 경계

**새 서명 인가 절차를 도입하지 않는다.** 기존 SB 정책과 JARVIS trusted key를
관리할 권한이 있는 운영자가 승인된 설치 설정을 확정한다. 회사 정책 변경의
명시적 운영 지시/승인 기록은 필요하지만 후보별 대표 decision 서명이나
새 bootstrap grant receipt를 발급하는 절차로 만들지 않는다.
Mail/processor 자격증명은 설정·키 등록·정책 version 변경 권한이 없다.
이 문서나 ordinary enrollment 요청은 운영자 설정 변경 승인 자체가 아니다.

운영자는 SB `owner_approval_keys` 옆에 `approver_principal_id=principal:owner`,
approval policy version, 대표 key ID/Ed25519/decision 용도/공개키 지문을 고정한다.
JARVIS에는 **기존** 대표 key `owner-decision-v1`의 실제 principal:owner,
decision 용도와 같은 공개키 지문을 company scope의 승인 목록으로 pin한다.
지문은 PEM 문자열 hash가 아니라 **DER SPKI bytes의 SHA-256**으로 정의한다.
목록은 key ID 순으로 정렬하고 ID 중복·잘못된 algorithm뿐 아니라 **SPKI 지문 중복**도
양쪽 binding 검증에서 거절한다. 다른 ID라도 같은 공개키이면 등록·활성화하지 않는다.
한 ID만 폐기하고 같은 material의 다른 ID로 서명하는 우회를 막기 위한 불변식이다.
현재 JARVIS registry의 공개키 중복 허용을 회사 binding의 허용으로 해석하지 않는다.
등록/현재 pin 재확인 모두 이 검증을 적용하고 T3/T9 및 독립 T16으로 증명한다.
SB purpose pin은 로컬 정책 항목이지 기존 principal/purpose registry라는 뜻이 아니다.
목록에는 대표 이외 key material을 넣지 않는다.

양쪽은 자기 로컬 신뢰 설정에서 binding을 산출한다. Mail의 기존 서명된
`enroll_handoff` 요청은 회사 scope/요청 권한만 증명하며 approver·승인 키 목록·
지문·승인 정책 version을 선택하는 필드를 싣지 않는다. 그런 override는 거절한다.
JARVIS 수입 args의 approver는 자기 등록 pin과 같을 때만 통과한다.
양쪽 산출 binding이 다르면 최초 등록을 완료하지 않고 fail closed 한다.

등록 증거는 각 DB에 immutable context와 binding digest, 승인자, 승인 키 목록의
principal(JARVIS)/purpose/algorithm/SPKI 지문, version, scope, 등록 시각,
운영 승인 기록 참조와 기존 enrollment 요청/서명 key ID·request digest를 남긴다.
비밀키나 token은 저장하지 않는다. 운영자 변경 기록과 등록 결과가 최초 확정의
감사 근거이고, 아래 후보 결정 receipt가 개별 accept/reject의 서명 근거다.
등록 완료는 양쪽 digest 확인 후에만 활성화하며 한쪽만 완료되면 mutation을 열지 않는다.
삭제 후 재등록으로 다른 pin을 끼워 넣지 못한다.

### 4.2 키·정책 pin과 단계별 재확인

새 binding canonical 입력은 provider/workspace/data owner/processor/approver,
승인 정책 version, wire revision, 정렬된 대표 key ID/algorithm/purpose/SPKI 지문이다.
`approval_binding_digest`는 이 입력의 canonical bytes hash다.
기존 데이터 `access.policy_revision`과는 **별도**인 `approval_policy_version`을 쓴다.
승인 version은 1부터 시작하는 양의 safe integer로 비교한다. digest와 공개키 지문은
`sha256:<64 lowercase hex>` 형식이며 binding hash는 아래 domain + canonical bytes다.
등록 context와 현재 로컬 설정의 어느 값이라도 달라지면 `ENROLLMENT_REQUIRED`
또는 JARVIS의 등록/current 거절로 멈춘다. 같은 key ID의 공개키 교체도 지문에서
거절한다. 새 key ID/목록 추가/purpose/principal 변경도 암묵적으로 허용하지 않는다.

옛 설정과 옛 context를 함께 되돌리면 equality만으로 탐지할 수 없다.
따라서 신규 등록 저장에는 scope별 **최고 확정 version과 binding digest**를
지속 보존하고 낮은 version, 같은 version의 다른 digest, 폐기한 binding 재활성화를
거절한다. 이 최소 신규 등록 증거는 필요하지만 legacy 이행 engine은 아니다.
정책/키 변경은 이후 명시적 운영 승인과 더 높은 version의 별도 전환 과제이며,
이 최초 등록 구현 PR은 기존 등록을 `DO NOTHING`/UPDATE로 바꾸지 않는다.
재시작에도 최고 version/pin/폐기 증거가 남아야 한다.
전체 DB 복구도 운영 감사 기준과 대조하며 백업만 덮어써 폐기를 지우지 않는다.

JARVIS는 import뿐 아니라 C1 승인 시점과 C2/C3 실행·SB 호출 직전·완료 직전에,
SB는 `authorize_transition`의 `require_enrollment`를 통해 accept/reject/mark_processed
각 시점에 현재 policy/version/key pin과 폐기를 재확인한다. stage cache만 믿지 않는다.
SB는 현재 허용 목록과 등록 pin, 폐기/활성 policy 상태를 대조해야 한다. JARVIS의
revocation DB가 SB에 자동 동기화된다고 가정하지 않는다. 양쪽 운영 변경 완료와
동일 binding 확인 전에는 mutation을 중지한다.
단계 사이 설정/key 폐기는 writer exclusion과 DB current-version guard로
검사/효과 경계를 지킨다. 외부 효과 뒤 폐기되면 사실을 보존하고 후속 mutation을
거절·조정하며 이미 수행한 accept를 없던 일로 되돌리지 않는다.

### wire·digest 개정 선택

현재 회사 contract는 strict v1 args, `company-handoff:v1` ID와
`second-brain/company-handoff/v1` domain을 사용한다. 그 bytes에 approver를
뒤늦게 붙여 기존 receipt를 유효하게 만드는 것은 금지한다.
후속 구현 선택은 **회사 전용 wire revision 2**다. 회사 command schema_version은 2,
ID는 `company-handoff:v2:<64hex>:<generation>`,
handoff hash domain은 `second-brain/company-handoff/v2` + NUL로 고정한다.
ID 본체는 `{target,args}`의 canonical bytes이며 args에는 required
approver_principal_id/approval_policy_version/approval_binding_digest를 포함한다.
binding hash 별도 domain은 `second-brain/company-approval-binding/v1` + NUL로
제안한다. 새 company 계약 선택이며 이미 배포됐다는 뜻이 아니다.
command_digest는 전체 command canonical bytes의 SHA-256이고 schema/version,
request_id·nonce, target, args, requested_by, 시간 필드까지 포함한다.
Python `canonical_bytes`/TS `canonicalize` 고정 입력 시험으로 byte·binding hash·
handoff ID·command digest 동등성을 확인한다.

**공통 저장·읽기·타입 경로도 회사2 구현 범위다.** 회사 parser만 바꾸지 않는다.
`stageControlCommand` (`src/control-command-stage.ts:18`)는 회사 action2만
선별 허용하고 다른 action은 기존1 계약·검사·digest를 유지한다. 공통
`ControlCommandRequestInput`/`StoredControlCommand`와 `controlCommandDigest`
입력 타입도 회사2/기타1을 구별한다. 전역적으로 모든 action에 `1 | 2`를 허용하지 않는다.
현재 INSERT는 version을 저장하지 않으므로 새 migration으로
`control_command_requests`에 실제 명령 version을 저장하는 `schema_version` 열을 추가하고
기존 행은1로 보존한다. shipped SQL은 수정하지 않는다.
같은 새 migration의 transaction 안에서 기존 `control_request_identity_immutable`
trigger를 **DROP한 뒤 다시 CREATE**한다. SQLite trigger를 제자리 수정하거나
배포된 `021_approval_control_plane.sql`을 고치지 않는다.
새 `BEFORE UPDATE OF` 보호 목록은 기존 request_id/action/action_level/target_json/
args_json/command_digest/reversible/requested_by/requested_at/expires_at/nonce를
모두 유지하고 **schema_version을 추가**한다. 기존 immutable identity의 ABORT를 유지하며,
state/lease 등 원래 허용한 비identity 갱신까지 전부 막는 trigger로 넓히지 않는다.
version UPDATE로1→2 또는2→1을 바꾸면서 서명 digest를 그대로 남기는 우회를
실제 DB 시험에서 거절해야 한다. 새 열 추가만 하고 기존 trigger를 그대로 두는 안은 불완전하다.
`decodeStoredControlCommand` (`src/control-command-read.ts:38`) 및 list/read는
저장된 version을 검증해 그대로 복원한다. action/ID만 보고 회사 기록을 무조건2로
재해석하거나 알 수 없는 version을1로 낮추지 않는다. 과거 회사1 기록의 읽기/
감사와 다른 작업1 동작은 보존하되, 옛 회사1 mutation은 새 binding에서 거절한다.
T14는 stage→실제 DB 저장→read/list→재시작 후 read→digest/서명 검증 왕복과
입력 원본/저장 digest 동등성을 증명하며, 다른 작업1 및 historical 회사1도 대조한다.
`OwnerInbox.list()`의 `src/owner-inbox.ts:327-329`도 이 범위다. Row/query에 저장
version을 전달하고 itemOf/company 표시 타입은 version별 args decoder를 고른다.
과거 회사1 전용 strict args schema는 보존하고, 새 회사2에는 required approver/
binding 필드를 검증한다. 과거1을2로 추측하거나 owner를 approver로 채우지 않는다.
v1/v2 혼합 inbox에서도 과거1 조회가 throw/유실되지 않고 원래 identity/digest를
보존해야 한다. 과거1 표시가 새2 mutation 권한을 열지는 않는다.

범용 approval receipt는 기존 schema_version 1/Ed25519/max_uses 1을 유지한다.
JARVIS `src/control-plane-contract.ts:78,94-113`의 기존 서명 형식대로
`orca-jarvis/command-approval/v1` + NUL + signature를 제외한 payload canonical bytes를
서명하고 signature는 base64url이다. receipt에는 실제 signer/key ID/request_id/
새 command_digest/nonce/decision/session/issued_at/not_before/expires_at을 둔다.
binding은 command args/digest를 통해 서명에 묶이며 signer 필드 위장은 pin 검사가 막는다.
SB `company_handoff_decisions`는 원래 approval bytes·receipt_id·request_digest를,
JARVIS `control_command_receipts`/`control_command_redemptions`는 실제 서명/상환을
보존한다. 동일 업무의 정해진 멱등 재시도와 새 사용을 구별한다.
다른 ID/digest/후보/operation에 receipt를 복사하거나 다른 서명으로 결정을 교체하면
거절한다. **옛 회사 v1 명령의 ID/digest에 묶인 receipt**는 새 mutation에 사용하지 않는다.
**새 회사 v2 명령 digest에 올바르게 서명한 v1 형식 approval receipt는 허용**한다.
여기서 봉투의 schema_version 1은 옛 명령 버전1과 다르다.
frozen MCP/scoped transport profile이나 그 sidecar를 이 문제 해결에 임의 변경하지 않는다.
구 v1 request는 history display/진단용만 읽고 새 binding의 mutation에는 사용하지 않는다.
approver 누락 시 owner fallback을 두지 않는다.

## 5. 현재 구현 범위: 기존 후보 불변, 최초 등록만

선행 snapshot은 회사 후보만 있고 handoff 테이블·회사 enrollment·수입이 없었다.
따라서 **현재 구현 PR에서는 old→new handoff mapping, outbox PK 재설계,
legacy enrollment epoch 전환, 두 DB transition engine을 구현하지 않는다**.
후보 전건 N의 IDs/content/access/state/deletion fence를 전후 비교하고 0건 변경한다.
일반 trusted_authority_keys의 기존 대표 key 등록은 금지 대상인 회사 enrollment와
다르며 그대로 사용한다.

활성화 gate는 운영 시점에 양쪽 writer/importer/processor를 정지·배제한 뒤
SB v1 outbox·회사 enrollment·JARVIS 회사 handoff/import·연결 control 기록이
**각각 0건**인지 다시 확인한다. 테이블 없음은 0으로 취급하되 query 오류나
버전/분류 불명은 0으로 간주하지 않고 거절한다. terminal/expired/superseded 기록도
예외로 넘기지 않는다. 하나라도 있으면 최초 등록/활성화 전에 중지하고 건수·종류·
scope·시각을 감사 기록에 남기며 삭제·덮어쓰기·묵시적 이행을 하지 않는다.
gate와 최초 등록 사이 새 legacy 기록을 만들 수 없도록 배제를 유지한다.
두 DB에 ACID가 있다고 주장하지 않고 초기 등록 digest 양쪽 확인 전까지 실행은 닫는다.
candidate 수신 동시성이 N 보존을 깨면 중지하고 재측정한다.

새 revision이 **이미 정상 활성화된 후 재시작**하는 경로는 최초 활성화와 다르다.
등록된 동일 새 context/pin/최고 version과 감사 증거를 검증해 그대로 재개한다.
초기 등록 일부만 성공한 경우는 양쪽 미활성 상태를 유지한 채 동일 binding의
멱등 재개만 허용한다. 다른 binding, legacy 발견, 증거 불일치면 자동 재등록하지 않는다.

### 5.1 legacy 발견 시 별도 전환 과제의 경계

아래는 **미구현 전환 절차의 설계**다. 기존 row를 삭제해 재수입하거나
`ON CONFLICT DO NOTHING`을 몰래 UPDATE로 바꾸는 운영 요령이 아니다.
아래 첫 행만 현재 구현 범위다. 나머지는 legacy gate 거절 이후 별도 구현·검토의
인수 조건이며 현재 PR이 이를 구현하거나 운영 이행을 수행한다는 뜻이 아니다.

| 실행 시 상태 | 처리 |
|---|---|
| 후보만 존재, 등록/outbox 없음 | 실제 N과 scope/fence snapshot → 승인된 새 binding의 첫 enrollment → 새 형식의 최초 handoff. 후보 row는 0건 변경 |
| outbox만 있고 JARVIS 미수입 | old bytes/ID/digest를 history로 보존, 승인된 binding 전환과 candidate별 old→new handoff mapping으로 새 revision 생성 |
| JARVIS pending/미결정 | 원래 request를 감사된 superseded/current-inactive 상태로 전환하고 새 request 생성. 동일 candidate가 두 개의 active approval subject가 되지 않음 |
| approved/rejected이나 미상환 | 옛 receipt는 원래 digest에만 보존, 새 request에는 대표의 새 결정 필요. 새 approver field만 바꿔 receipt를 복사하지 않음 |
| 상환/accept 효과 또는 결과 불확실 | drain/조정으로 정확한 authoritative receipt/state부터 확정. 불확실하면 격리하고 새 request로 blind replay 금지 |
| processed_complete/rejected terminal | 과거 decision/effect/provenance 보존, 자동 재승인 대상 생성 금지 |
| 기존 enrollment 있음 | old context history 유지, 승인된 명시적 binding epoch 전환. “다시 enroll을 호출하면 덮어쓴다”는 안은 현재 코드와 다름 |

현재 prepare_handoff의 generation은 **같은 identity**가 만료됐을 때의 갱신이다.
approver가 달라져 identity가 바뀐 정책 전환을 그 generation++로 처리하지 못한다.
별도 legacy 전환 과제에는 immutable historical handoff와 audit mapping/current revision이 필요하다.
SB outbox PK(workspace,candidate)와 decisions PK가 이를 제한하므로 schema·store 변경을
포함하고, JARVIS에도 old/new/current 관계를 보존한다.
shipped SQL 수정이 아니라 새 migration으로 구현해야 한다.

별도 전환 과제에서도 SB DB와 JARVIS DB 사이에 하나의 ACID transaction이 있다고 가정하지 않는다.
각 DB 안의 전환은 원자적으로 하고, 공통 transition ID/old-new digests/
binding epoch/상태/ack를 durable하게 기록해 uncertain ack 이후 재개한다.
재시도는 그 transition ID에 idempotent하며 이미 소비된 결정을 두 번 실행하지 않는다.
새 request 생성 전에 구 request의 mutation capability가 비활성화됨을 확인한다.

현재 최초 등록도 모든 writer/processor를 새 guard가 있는 버전으로 정렬한 뒤 활성화한다.
구 writer가 새 DB의 상태 전환을 우회할 수 없도록 schema/runtime compatibility도
검증한다. 데이터 access.policy_revision은 그대로 보존하고 승인 binding 개정 번호를
그 필드 대신 사용하지 않는다. deletion high-water mark는 단조 증가한다.
후보 전건 manifest는 원본 IDs/digest/state/scope/fence를 비교하고 뒤늦은 유입을
다음 cohort에 포함한다. 작성자 정보는 인증된 원본 provenance에서 가져오며 추측하지 않는다.

**선행 준비에 대한 정정:** 제공 분석의 “오늘 준비에 등록했다면 재등록”은 조건문이다.
실제 01~05는 등록하지 않았으므로 해당 snapshot에 재등록 부채는 없다.
다만 이후 다른 실행으로 등록/수입됐다면 현재 활성화를 거절하고 위 별도 과제를 연다.

## 6. 후속 구현 범위와 시험 인수 조건

다음은 **미래 구현 PR의 시험 요구**다. 설계 PR #88에서 실행한 시험이나
보안 통과 판정이 아니다. C1~C5를 모두 고치고 실패 경로를 독립적으로 증명해야 한다.
기존 JARVIS `tests/unit/company-candidate-{import,execution,transport}.test.ts`,
`tests/unit/cli-company-candidates.test.ts`와 SB
`tests/test_company_candidate_handoff.py`, `tests/test_company_memory_registration.py`,
`tests/test_company_memory_key_scope.py` 시험군을 확장한다.
T 번호는 새 파일/API가 아니라 추가할 시험 시나리오 식별자다.

### 6.1 가재·나희 기준 -> 코드 -> 시험

| 검토 기준 | 보장해야 할 코드/저장 지점 | 구현 시험 |
|---|---|---|
| 최초 승인자는 운영자가 확정; 요청자가 변경 불가 | 4.1 로컬 policy/JARVIS trusted 등록 -> 양쪽 enrollment_context; Mail enrollment override 거절, C1~C4 fixed 대조 | T1 정상 최초 등록, T2 Mail/processor가 approver/key/version을 보내거나 설정을 바꾸려 하면 거절 |
| principal·purpose·지문·키 목록 pin | JARVIS registry/C1/C2/C3, SB 대표 전용 owner_approval_keys·policy pin·기존 공개키 바이트 분리 + 신규 key ID 충돌 및 승인 목록 내부 SPKI 중복 거절; immutable context | T3 같은 key ID의 새 material, 다른 principal/purpose, 추가 key·shared material/ID 충돌 거절; T16 다른 ID/같은 SPKI 및 폐기 alias 거절 |
| 기록 전 고정 키 검증(P1) | C1 ControlPlane.decide의 approve/reject transaction 전 fixed key ID/purpose/SPKI 대조 | T17 같은 대표 principal의 유효한 비pin key로 approve/reject 모두 거절, pending 유지·receipt/이벤트 생성0·상환 불변, 뒤이어 실제 pinned 결정 성공 |
| 승인자·승인 정책 버전·키 pin이 서명에 묶임 | 새 strict args + binding hash + handoff ID + controlCommandDigest; SB canonical_bytes와 JARVIS canonicalize | T4 각 binding 필드 변경/유효한 공격자 서명/옛 버전 거절; T5 양 언어 동일 canonical bytes/digest |
| 옛 policy 복원·등록 교체 차단 | 현재 context exact equality + scope별 durable 최고 version/digest/폐기 증거, 삭제 후 재등록 금지 | T6 낮은 version, 같은 version 다른 digest, 옛 context 동시 복원, 재시작 뒤 rollback 거절 |
| 대표만 approve/reject/완료 | C1~C5와 SB270/mark_processed 원래 approve receipt; 데이터 owner/requested_by 유지 | T7 대표 accept/reject/검증된 mark_processed 성공; T8 Mail/processor/다른 signer/미등록 key/spoof 거절 |
| import 이후 각 단계에서 현재 정책·폐기 재확인 | C1/C2/C3의 SB 호출/완료 직전 guards, SB authorize_transition228의 require_enrollment 및 현재 pin/폐기 | T9 승인→수신→완료 사이 key 교체·폐기·정책 변경·재시작·양쪽 version 불일치 거절 |
| 옛 명령 서명 재사용과 새 사용 차단 | request_id/command_digest 일치, SB company_handoff_decisions283-305, JARVIS receipts/redemptions, current binding | T10 옛 명령1→새 명령2/다른 후보·generation·operation·binding 재사용 거절; 새 명령2에 서명한 봉투1은 T7에서 허용 |
| 만료 후 마무리 재시도 명확 | 6.2 완료 증거 + C3/current pin + 저장된 SB accept receipt와 redemptions, fresh accept 금지 | T11 만료 뒤 무수신/불확실 accept 거절; 확인된 동일 accept의 완료만 허용; revoked/binding 변경이면 완료도 거절 |
| 현재 legacy 기록 0, 없을 때만 활성화 | 5절 activation gate·writer 배제·초기 양쪽 digest 확인; 삭제/전환 대신 감사 중지 | T12 각 legacy 기록 1건/직전 삽입/query 오류/양쪽 등록 일부 성공이면 실행 미활성; 전건 N 불변 |
| legacy 전환의 감사·되돌리기 | 현재는 gate 거절 기록과 원본 보존; 5.1 별도 transition manifest, 7절 rollback | T12 현재 거절 후 원본 불변; 향후 실제 전환 과제는 old/new·uncertain·terminal·rollback 시험 별도 |
| 인접 권한 회귀 없음 | requested_by==owner65, SB owner/project/policy/fence, 타 action owner guard·Mail receive-only | T13 기존 개인/daily/다른 회사 scope·data fence·owner/requester 거절 시험 유지 |
| 회사2의 저장·읽기·타입/digest 왕복, 기타1 보존 | 공통 control-command-stage18/INSERT, control-command-read38/read/list, control-plane-contract 타입·digest, 실제 version 열 + identity trigger 재생성, owner-inbox327-329의 version별 args | T14 회사2 왕복/digest 같음; 기타1/과거1 inbox 혼합 조회 보존; version UPDATE/미지원 version 거절 |
| 대표 결정(10/15 09:23:05 KST (Slack C0C6HJM0BV5:1792023785.146919, "오모냥아 진행해"), 진행): 키 교체 시 회사 승인함 일시 중지 수용, 재개 절차는 오모냥 담당 별도 과제 | SB 목록/pin 변경 -> 등록 exact mismatch -> ENROLLMENT_REQUIRED, 7절 결정 근거·전환 담당 | T9 폐기/교체 뒤 승인·수신·완료 중지; 삭제 후 재등록/구 pin 복구로 몰래 재개 불가 |
| accept/reject ack 유실 뒤 실제 receipt·시각 조회 | 6.4 새 processor-only read, SB 원본 receipt/decision, JARVIS 복구 저장 | T11 accept 및 T18 reject의 실제 SB commit 뒤 응답 유실·재시작·만료 후 원본 조회, 읽기 전후 mutation 0 |
| 외부 verifier 회사2 wire | 6.5 config2/stdin2/응답2, execution.ts26-95와 operator 문서 | T15 실제 child/durable effect/executor/mark_processed 통합과 실패 거절 |

### 6.2 만료 후 마무리 재시도 규칙

새 accept/reject와 최초 상환은 command/receipt의 현재 시간 유효성을 만족해야 한다.
command TTL 24시간, approval TTL 최대 30분 및 not_before 제한은 유지한다.
승인 사실이나 JARVIS redemption만으로 만료 후 accept를 새로 보내지 않는다.

만료 뒤에는 **같은 request_id/command_digest의 SB accept receipt가 확인·보존돼 있고**,
당시 수신 시간에 원래 approval이 유효했음이 증명되는 경우만 기존 작업의 완료 검증/
mark_processed를 재개한다. 원래 receipt bytes, 승인 binding, candidate/content/fence와
acceptance_receipt_digest를 그대로 쓴다. 시간만 과거 수신 증거로 확인하며 현재
key 폐기/pin/version/등록 검사는 건너뛰지 않는다. 현재 binding 변경/폐기면
마무리도 중지·조정한다. 새 approval/receipt transplant/새 command 재실행이 아니다.
확인된 완료/거절 결과 조회는 읽기이며 이 규칙으로 새 mutation을 만들지 않는다.

SB accept/reject 결과가 불확실하거나 로컬 transition receipt가 없으면 authoritative 상태/receipt를
먼저 6.4의 인증된 읽기 전용 조회로 대조하고 확인 전 blind resend/자동 성공을 금지한다.
accept만으로 processed_complete가 되지 않는다. 실제 completion verifier 결과와 정확한
acceptance receipt 바인딩이 있어야 한다. 같은 완료 재시도는 원본 한 effect를 반환하고
다른 completion/receipt로 덮어쓰기나 terminal→candidate를 거절한다.
현재 SB283-290의 동일 decision 재사용은 시간 재검사 전에 돌아오므로 이를 무제한
예외로 확대하지 않고 위 상태/current-binding/원본증거 경계를 명시적으로 시험한다.

### 6.3 구현 PR 시험 목록

고정 시각과 event/state 구독을 사용한다. 고정 sleep, timing luck, 통째 mock으로
권한 경계를 제거하는 시험은 쓰지 않는다. 실패 시 실제 state/effect 불변도 확인한다.
대표 key를 운영에서 사용하지 말고 저장소의 격리된 시험 key/fixture를 쓴다.

| ID | 반드시 실행할 입력/상태와 이진 결과 |
|---|---|
| T1 | legacy 0인 양쪽 동일 local pin의 최초 등록/활성화 성공; snapshot/digest/audit 일치, candidate 0건 변경 |
| T2 | Mail/processor enrollment에 approver/key 목록/pin/version override, 자기 key를 대표로 지정, 운영자 설정 권한 시도 -> 모두 거절 |
| T3 | 같은 key ID 다른 공개키, 다른 ID 같은 DER-SPKI 지문, actual key/pin 불일치, principal 위장, purpose 비decision/누락, 비Ed25519, 중복/미등록/목록 추가 key, 대표와 Mail/processor 동일 ID 또는 material -> 모두 거절 |
| T4 | approver·approval version·key 목록·지문·purpose·binding digest 중 하나를 바꾸고 새 digest/유효 서명 생성 -> fixed 대조에서 거절; 누락/unknown args/구 schema/ID/domain도 거절 |
| T5 | 공유 고정 JSON: 다른 object key 순서, 정렬된 key 목록, 한글/NFC, projects/정수 fence/시간/null 허용 여부를 strict 계약대로 양쪽 계산 -> canonical bytes·binding hash·handoff ID·command_digest·signature payload bytes 같음; 1필드 변경 시 다름 |
| T6 | 설정만 변경, context만 변경, 낮은 version, 동일 version 다른 pin, 옛 설정+옛 context 복원, 삭제 후 재등록, 재시작 뒤 최고 version 소실/불일치 -> 거절/실행 미활성 |
| T7 | 새 회사 명령2 digest에 서명한 **봉투1**의 고정 대표 receipt로 accept/reject 성공·원래 approve receipt와 실제 완료 증거로 mark_processed 성공; accepted와 processed_complete 구별, 원래 signer 기록 |
| T8 | mail-ms/ordinary handoff key, processor, 다른 대표/legacy jm-owner, 미등록 key, 올바른 signer 필드에 다른 key, 대표 key에 다른 signer 필드 -> approve/reject/mark_processed 모두 거절 |
| T9 | 승인 후 accept 전/accept 후 완료 전 key 교체·삭제·폐기·purpose/principal/pin/version 변경, 재시작, SB/JARVIS 다른 version -> 다음 mutation 거절; 한 ID 폐기 뒤 같은 SPKI의 별도 ID로 재시도도 거절; 이미 수행한 effect 보존 |
| T10 | **옛 명령1 ID/digest의 receipt**를 새 명령2에 이식, 다른 request/후보/workspace/provider/generation/operation/binding 복사, 기존 결정의 서명 교체, 상환 receipt 새 사용 -> 거절; 봉투1 자체는 금지하지 않으며 동일 원본 재시도 effect 1회 |
| T11 | SB accept commit 뒤 응답 유실·persistReceipt 전 crash→재시작→새 인증 read로 원본 receipt/accepted_at 복구; 만료된 동일 완료만 재개, accept 효과1회. 시간/nonce/scope/digest/권한/폐기/부재·손상·불확실이면 mutation 0; 조회 전후 DB 불변 |
| T12 | v1 outbox·등록·JARVIS 수입/관련 control 기록 각각 1건, expired/terminal 포함; gate 직전 동시 삽입/query 실패/버전 불명/한쪽 등록 실패 -> 활성화 거절·감사·원본 유지; 0/24/27/N+동시 후보 수신 보존 |
| T13 | owner/project/data policy/deletion fence/content/requested_by 변조, completion 누락/다른 candidate/digest/acceptance_receipt_digest, reject 후 mark_processed -> 거절; 타 action·개인/daily·Mail receive-only 회귀 통과 |
| T14 | 실제 공통 stage/store/read/list와 재시작 후 회사2 decode/digest == 원본/저장 digest, 봉투1 signature 성공; 기타1 불변; 과거 회사1 args에 새 approver 필드가 없어도 OwnerInbox.list() 및1/2 혼합 조회 정상·identity/digest 보존; 새2 필드 검증; version UPDATE1→2/2→1 거절·원래 row/digest 불변; 다른 action2/미지원 version 거절 |
| T15 | 실제 고정 executable에 stdin2/command2/원래 acceptance 전달→독립 durable effect·완전 응답2 검증 후에만 mark_processed; v1/변조/JSON·종료·stdin·timeout 오류는 완료0, child 종료/lease 해제/효과1회 |
| T16 | 양쪽 binding 입력에 ID A/B와 같은 DER-SPKI 지문을 넣으면 등록/활성화 거절; fixture로 중복 pin을 주입하고 A 폐기 후 B로 유효 서명해도 C1~C4 현재 검증에서 거절, receipt/상환/효과 0. 서로 다른 ID·SPKI의 정상 목록은 허용 |
| T17 | 실제 ControlPlane.decide에 같은 principal이지만 고정 목록에 없는 유효한 키로 approve·reject를 각각 시도 -> 요청은 pending 그대로, receipt·이벤트 생성0, 상환 불변; 그 뒤 같은 요청에 고정된 정상 키로 결정 성공. key ID/실제 SPKI 불일치·잘못된 purpose도 독립 거절. C2 실행 없이 실제 DB와 이벤트 기록/발행 경계에서 증명 |
| T18 | 실제 SB reject commit 뒤 응답 차단·persistReceipt 전 crash→재시작→원래 approval/authority 만료 후 fresh 인증 read로 exact reject receipt/원래 결정 시각 복구; 로컬 거절 증거만 저장, reject 재전송0/효과1회/mark_processed0. accept 증거 교차·잘못된 operation/request/시각·권한/부재·손상/timeout은 불확실 유지, 조회 전후 SB DB 불변 |

T14는 기존 `tests/unit/control-plane.test.ts`,
`tests/integration/control-command-lookup.test.ts` 및
`tests/integration/control-command-page.test.ts`와 company import/execution 시험에
통합한다. DB/read를 mock으로 없애면 read의 강제1 복원 회귀를 잡지 못한다.
과거1 DB를 새 migration으로 올린 fixture와 신규2 fixture에서 raw SQL
`UPDATE control_command_requests SET schema_version=2 WHERE request_id=?`와
`UPDATE control_command_requests SET schema_version=1 WHERE request_id=?`를 각각 시도해 실제 ABORT와
행/version/command_digest 불변을 확인한다. 기존 보호 열의 변경 거절도 유지하고,
정상 state/lease 갱신은 기존 제어 경로에서 성공해야 한다. trigger 이름/DDL 문자열만
비교하거나 store를 mock해서 이 거절을 증명했다고 하지 않는다.
inbox 시험은 과거1/새2/혼합 행을 실제 조회해 version별 args 및 기존 표시 계약을
확인한다. 과거1을 숨기거나 v2 필드를 억지로 채워 통과시키지 않는다.

| 범위 | 변경/회귀 확인 |
|---|---|
| JARVIS company-candidate-contract / context·transport·import | required approver/version/binding·새 digest/ID, owner/source/access 값 보존, caller override 거부, 동일 export idempotency |
| JARVIS 공통 stage/read/type/store | control-command-stage.ts18/INSERT, control-command-read.ts38/read/list, control-plane-contract.ts 타입·digest, schema_version 열/new migration +021:69 identity trigger DROP/CREATE. 회사2 왕복과 다른 action1 보존 |
| JARVIS control-plane62 / execution139·217 | C1에서 receipt/state 쓰기 전 signer·key principal/ID/purpose/SPKI를 fixed와 비교; C2/C3 현재 재확인. 타 action owner guard는 동일; accept/reject와 completion 모두 |
| JARVIS owner inbox/read model/store | owner-inbox.ts327-329·Row/query/표시 타입의 version별1/2 args 읽기와 과거1 inbox 시험 필수; receipt 실제 signer 위장 금지. 광범위 author provenance/UI 재설계는 제외 |
| SB CompanyHandoffPolicy/ControlArguments/enrollment_context | 로컬 고정 pin·분리된 승인 version, role/key material disjoint, scope/deletion 유지, 최초 immutable 등록 증거 |
| SB prepare_handoff/authorize_transition/store | 새 identity/digest·현재 등록/key pin 재확인·원래 receipt와 terminal 보존; legacy mapping 제외 |
| 신규 등록 저장·release gates | 필요한 새 필드/migration만, 최고 version·backup/compatibility·legacy0 직전 gate·초기 양쪽 digest 확인·old writer 차단; legacy2DB transition engine 제외 |
| Mail producer | B에서는 후보 owner 재작성 없음. 기존 receive-only/source 계약과 provenance 유지 여부를 회귀 확인 |

새 시험은 기존 company 단위/통합 시험군에 추가하고 각 거절 원인을 독립적으로 검증한다.
이 문서에서는 시험 실행·키 생성·가짜 또는 실제 owner 서명을 하지 않았다.

| 시나리오 | 후속 구현의 이진 인수 결과 |
|---|---|
| fixed 대표 key/principal로 같은 provider/workspace/candidate/digest 승인 | accept/reject 성공, 원래 실제 signer 기록 |
| 다른 대표/legacy jm-owner/non-decision key | 거부 |
| processor key 또는 mail-ms/ordinary handoff key의 승인 | 거부 |
| approver 값만 바꿈/키 principal 위장/다른 workspace·projects·binding | signature/digest/policy 경계에서 거부 |
| approver 필드 누락, 옛 회사1 명령에 묶인 receipt를 새 request에 복사 | 거부; owner fallback 없음. 새 회사2 digest를 서명한 봉투1은 허용 |
| revoked/expired/not-yet-valid key·receipt, nonce/digest 변조 | 기존 거절 유지 |
| 정상 owner=mail-ms 후보 export 및 requested_by | data owner/requester 그대로, scope filter 통과 |
| 24/27/0/N 후보 및 concurrent receive | 전건·원본 bytes/digest/state/fence 보존, 누락·중복 0 |
| legacy pending/approved/terminal handoff 발견 | 최초 활성화 거절; 전환/새 request 자동 생성 없음 |
| 새 revision 상환/ack 불확실/terminal | 원본 대조·동일 완료 재시도 또는 격리, 이중 effect/상태 회귀 0 |
| 이미 등록된 context·policy 변경 | 암묵적 upsert/unenroll/키 교체 금지; 후속 명시적 전환 과제로 중지 |
| mark_processed에서 approver/binding/원래 receipt/실제 완료 증거 | 올바른 경우만 성공; accept만으로 완료 금지 |
| 개인 memory/daily/다른 company scope·Mail receive-only | 기존 권한/격리 불변 |

### 6.4 인증된 읽기 전용 accept/reject receipt 조회 — 후속 P2

현재 `src/company-candidate-transport.ts:54-85`는 handoff/accept/reject/
mark_processed만 허용한다. 아래는 **새 구현 계약**이며 현재 조회 API가 있다는 뜻이 아니다.
제안 operation은 `read_transition_receipt`, purpose는 `company_memory_receipt_read`다.
앞선 accept-only `read_acceptance_receipt` 제안을 대체하며 accept/reject 모두 지원한다.
기존 company private broker의 processor 역할에만 추가하고 Mail/handoff·개인 memory
권한에는 열지 않는다. transport/broker allowlist와 SB authority/CLI/read-store,
JARVIS 복구 저장을 함께 구현한다. 새 control command나 대표 결정/상환 API가 아니다.

기존 Ed25519 authority 봉투1을 사용하되 새 조회 nonce/request_digest, 짧은 TTL,
현재 고정 provider/workspace/processor/projects/policy/삭제 fence를 검증한다.
만료된 accept/reject authority를 재전송하지 않는다. 요청 args는 candidate_id/handoff_id/
operation=`accept|reject`/transition_request_digest/command_digest/content_digest/
approval_policy_version/approval_binding_digest의 closed object다.
operation은 둘 중 하나의 exact 값이다. 원래 transition_request_digest는 보존한 실제
approval bytes와 원래 accept 또는 reject args로 재계산한다. accept는 approve,
reject는 reject decision과 매칭하며 서로의 receipt를 대신 쓰지 않는다.
SB는 현재 로컬 scope/binding과 processor key를 검증한 뒤 원본 receipt 및
company_handoff_decisions의 같은 workspace/candidate/handoff/decision/request_digest를 읽는다.
조회는 execute/accept/reject/authorize_transition를 호출하지 않으며 후보·decision·상환·
receipt·결정 시각·등록을 생성/변경하거나 schema를 초기화하지 않는다.

응답2는 위 identity/binding과 outcome, lookup_nonce/lookup_request_digest를
반드시 echo한다. found에는 원래 receipt_id/receipt_digest/operation/state/handoff_id,
accept에는 원본 snapshot의 accepted_at, reject에는 원래 reject 결정 시각을 포함하고
둘 다 원래 receipt_created_at을 보존한다. reject 결정 시각의 immutable 저장 필드도
후속 계약에 명시하고 필요하면 reject 전이/receipt와 같은 transaction에 추가한다.
조회가 기존 reject 시각을 만들거나 accept의 accepted_at으로 채우지 않는다.
not_found는 인증/정상 조회가 끝났으나 그 행이 없는 경우에만 쓰며, 동시 accept/reject의
영구 부재나 재전송 허가로 해석하지 않는다. 시각 부재/불명확·손상·권한 거절·
미초기화·timeout·응답 누락은 evidence_absent/거절/uncertain으로 유지한다.
unknown을 성공/not_found로 바꾸지 않는다.

SB `company_memory.py:409-520`은 전이와 원본 receipt를 한 transaction에 저장한다.
result_json에는 accepted_at이 있지만 현재 wire의 축약5필드에는 없다.
SB는 원본 전체 result/created_at을 기존 receipt domain으로 재해시해 ID/digest를
검증한 뒤 본문을 제거한 projection만 반환한다. 후보 본문/approval 원문은 반환하지 않는다.
JARVIS는 축약 응답으로 원본 전체 receipt hash를 재계산했다고 주장하지 않는다.
hash나 nonce echo 자체는 인증이 아니다. 운영자 고정 broker/SB 실행 경로와
소켓 소유·권한·교체 방지/peer 신뢰가 검증된 채널만 허용하고 scope/digest/nonce를
모두 대조한다. 호출자 지정 소켓/프로그램/임의 JSON·UI·캐시로 대체하지 않는다.
새 응답 서명 키나 신뢰 root를 만들지 않는다.

accepted_at은 **해당 원본 receipt snapshot**에서만 가져온다. 조회 시각, approval
issued_at, JARVIS redemption 또는 receipt_created_at으로 채우지 않는다.
이미 accepted인 후보의 다른 요청에서는 두 시각이 다를 수 있다. 그 값이 해당
original approval의 유효 구간과 exact 요청에 대한 수신 증거를 입증하지 못하면
완료도 중지한다. 검증된 found를 로컬 저장한 뒤에만 6.2의 당시 승인 유효성과
현재 key/policy/fence/폐기를 재확인하고 완료를 재개하며, accept는 다시 보내지 않는다.
reject도 exact 원본 receipt/decision/operation 및 당시 유효성을 검증한 경우에만
로컬 terminal 거절 증거를 복구한다. reject를 다시 보내거나 새로운 결정/상환을 만들지
않으며 mark_processed를 호출하지 않는다. 원래 reject 시각이 없거나 불명확하면
조회/approval issued_at/receipt_created_at/JARVIS redemption 시각으로 추정하지 않고
불확실 상태와 격리를 유지한다. 현재 권한·binding·fence 검증도 생략하지 않는다.

| 검토 기준 | 구현 지점 | 미래 T11/T18 증거 |
|---|---|---|
| 응답 유실 뒤 실제 수신 증명 | 새 read operation/purpose, SB 원본 receipt/decision, JARVIS 복구 | 실제 SB commit 뒤 응답 차단·persistReceipt 전 crash→재시작→fresh read→원래 receipt/시각 복구, accept 효과1회 |
| reject 응답 유실도 복구 | 같은 read의 operation=reject 및 원본 reject decision/receipt/시각 | T18 실제 reject commit/crash/만료 뒤 조회, reject 재전송0·거절 효과1회·완료0; accept receipt 교차 거절 |
| 읽기가 mutation을 숨기지 않음 | readonly store와 인증/응답 validator | 조회 전후 후보/decision/상환/receipt/시각 DB 불변; 재전송0 |
| 잘못된 증거는 만료 연장 아님 | exact scope/request/binding/nonce와 현재 guard | 권한·폐기·fence/시각·digest·대상 변조, 부재/손상/timeout이면 완료0, original receipt/current guard 모두 보존 |

T11/T18은 in-process callback만이 아니라 실제 SB transaction과 인증 read를 통과한다.
원래 authority/approval 만료 뒤에는 새 조회 authority로 accept/reject 증거만 회복한다.
commit/응답 차단/프로세스 종료 이벤트를 먼저 구독하며 fixed sleep을 쓰지 않는다.

추가 근거는 head `8b5f50e`의 Codex 원문
[SPKI 중복](https://github.com/whelp99-code/Orca-JARVIS/pull/88#discussion_r4277969673),
[C1 기록 전 검증](https://github.com/whelp99-code/Orca-JARVIS/pull/88#discussion_r4277969675),
[reject 복구](https://github.com/whelp99-code/Orca-JARVIS/pull/88#discussion_r4277969679)다.
심각도는 SPKI 중복 P2, C1 기록 전 검증 **P1**, reject 복구 P2다.
각각 T16/T17/T18로 독립 검증하고 기존 T3/T9/T11을 유지·확장한다.

### 6.5 completion verifier v2 stdin·응답과 실제 subprocess — 후속 P2

현재 `src/company-candidate-execution.ts:26-35,40-95`와
`docs/personal-os/company-candidate-handoff.md:140-160`은 config/stdin/completion1이다.
미래 회사2 구현은 운영자 고정 private config도2로 명시하고 executable/args와
함께 배포한다. config2는 schema_version/executable/args의 closed object이며
trusted path·소유·권한·0600·인자 상한16을 유지한다. config1 자동 승격/v1-only
binary fallback을 두지 않고 활성화 전 격리된 실제 subprocess rehearsal로 확인한다.
현재 v1 운영 문서는 이 설계 PR에서 바꾸지 않고 실제 구현 PR에서 함께 개정한다.

stdin은 UTF-8 canonical JSON 한 객체 `{schema_version:2,command,acceptance}` 뒤 EOF다.
command는 strict 회사 명령2 전체 원본이다. acceptance는 보존 또는 6.4 조회로
검증한 원래 SB5필드 metadata다. SB receipt의 cmreceipt:v1 및 대표 approval 봉투1은
verifier wire2와 별개이며 원본을 유지한다. 비밀키/credential/후보 본문은 넘기지 않는다.
stdout은 로그·추가 객체 없는 closed completion2다: schema_version=2,
state=`completed`, request_id=`company-handoff:v2:...`, command_digest,
candidate_id, content_digest, acceptance_receipt_digest, effect_digest.
원래 command/acceptance와 모든 identity/digest를 대조하고 현재 guard를 재확인해
completion2를 저장한 뒤에만 mark_processed를 보낸다. 응답1을2로 감싸 통과시키지 않는다.

프로그램은 request_id+command_digest로 실제 후속 효과를 멱등 실행하거나 독립 검증한다.
exit0/입력 echo/임의 effect_digest만으로 완료라고 하지 않는다. 기존 shell:false,
최소 env,10초/SIGKILL,1MiB, stdin 실패 kill/lease 해제를 유지한다.
실패해도 확인한 accept는 보존하지만 processed_complete로 올리지 않는다.

| ID/검토 기준 | 구현 지점 | 미래 실제 시험 |
|---|---|---|
| T15 양방향 wire2 | createCompanyCompletionVerifier/config·stdin·completion parser, operator 문서 | 실제 고정 child가 stdin2/command2를 strict parse하고 durable effect 생성·독립 hash·완전 응답2 반환→executor 검증 후 mark_processed |
| T15 버전/증거 거절 | 실제 stdout→executor binding/current guard | v1-only child/응답1, 다른 ID/digest/acceptance/effect, 오염·부분·중복·과대 JSON·비정상 종료이면 완료0 |
| T15 자원/멱등성 | 실제 child/lease/effect 저장 | stdin 오류·timeout에서 child 종료/lease 해제, 재시작·동일 요청 재시도 effect1회, 다른 요청으로 원본 이식 거절 |

기존 `tests/unit/company-candidate-execution.test.ts:358-545`의 실제 executable
패턴을 확장한다. CompanyCompletionVerifier mock만 쓰거나 createVerifier 단독의
불완전 출력만 검사하지 않고 execFile/stdin/EOF/stdout/executor 전체 경계를 통과한다.
child readiness/close와 효과 기록 이벤트를 먼저 구독한다. 기존 v1 path/timeout
회귀 시험을 삭제·약화하지 않고, T7 정상 완료도 이 실제 T15 경로로 확인한다.

## 7. 되돌리기와 추천 이유

**B를 추천하는 이유:** 데이터 권리와 원본 보존을 건드리지 않고,
누가 회사 결정을 승인하는지 별도 명시한다. key principal은 실제 대표로 남고
Mail과 processor의 승인권은 확대하지 않는다. 새 grant 범위는 이 company binding으로
제한한다. A/C는 데이터 소유 정본화라는 다른 사업 요구와 넓은 이행을 만든다.

새 binding으로 상환되기 전에는 새 수입/결정 전환을 중지하고 policy 활성화를
감사된 절차로 취소할 수 있다. DB가 진전됐으면 old executable만 current로
되돌리지 말고 compatibility gate를 통과하는 방식만 허용한다.
새 receipt 상환/업무 효과/삭제 이후에는 기존 사실과 high-water mark를 보존한다.
승인된 다음 epoch로 전진하거나 검증된 전체 복구를 검토하며, completed→candidate,
삭제 부활, old receipt의 새 digest 이식은 허용하지 않는다.

최초 승인자 신뢰는 기존 운영자 설정/키 등록에서 확정하며 별도 서명 ceremony는
추가하지 않는다. 후속 구현은 여기 정한 회사 전용 wire/hash와 pin/등록 증거를
계약으로 확정·검증해야 한다. 문서는 구현·운영 변경 승인·운영 실행을 대신하지 않는다.
legacy 기록이 활성화 직전에 발견되면 임의 확대하지 않고 중지한다.
회사 자체의 법적 data owner를 바꾸는 요구가 생기면
A/C를 별도 권리 이행 과제로 결정한다.

**대표 결정(10/15 09:23:05 KST (Slack C0C6HJM0BV5:1792023785.146919, "오모냥아 진행해"), 진행): 키 교체 시 회사 승인함 일시 중지 수용, 재개 절차는 오모냥 담당 별도 과제**다.
대표 키 교체 = 전환 과제 구현 전까지 회사 승인함 승인 중지
(`ENROLLMENT_REQUIRED`, 안전 정지).
SB에는 현재 별도 승인 키 폐기 원장이 없으므로 폐기/교체를 위해
`owner_approval_keys`를 바꾸면 고정 등록 pin과 불일치한다. 이 상태에서 신규
승인·수신·처리 완료 mutation을 재개하지 않는다. 오래된 pin으로 복귀하거나
등록을 삭제해 재등록하는 우회도 금지한다. 기존 수행 사실/읽기 조회는 보존한다.
더 높은 승인 version의 명시적 재등록·양쪽 binding 전환은 이번 구현 범위 밖이다.
그 **복구·전환 과제 담당은 오모냥(계획·배정)**이다. 과제 구현·검증 완료 전까지의
운영 경계는 **대표 결정(10/15 09:23:05 KST (Slack C0C6HJM0BV5:1792023785.146919, "오모냥아 진행해"), 진행): 키 교체 시 회사 승인함 일시 중지 수용, 재개 절차는 오모냥 담당 별도 과제**다.
담당 지정은 복구 절차의 계획·배정 책임이다. 일시 중지 수용은 담당 지정에서 추정하지 않고
다음 대표 응답에 근거한다.

**대표 응답 근거(사용자 전달):** 10/15 09:23:05 KST
(Slack `C0C6HJM0BV5:1792023785.146919`, "오모냥아 진행해").
**선택지1 해석 기록:** 오모냥이 이 응답을 선택지1로 해석한 시각은
09:23:26 KST, Slack `C0C6HJM0BV5:1792023806.828569`다.
대표의 원문과 오모냥의 선택지 해석은 주체·시각이 다른 두 기록으로 구분한다.
이 결정은 앞선 결정 대기 상태를 대체한다. 이번 변경은 문서 기록이며 실제 키 교체·
운영 등록·배포·재개 전환 과제는 실행하지 않았다.

## 검수와 종료

초안 단계의 사용자 조사·세 named 파일의 행 인용 보완·architect 위험 비교를 이어받고,
이번 보완에서는 가재/나희 원문 여섯 개와 기존 서명/실행·stage/read·키 분리 경로를 좁게 대조했다.
코드 조사 중복과 전체 AST/DB 재조사는 하지 않았다.
초안의 Raw GitHub URL404는 authenticated contents 조회로 필요한 인용만 보완했다.
secret-bearing download URL/token은 문서에 보존하지 않았다.
pure prose이므로 새 test·코드 helper·제품 build/run을 만들지 않고 QA-by-read했다.
읽기 전용 source ref와 source checkout 보존, 문서 범위·금지 우회·N건/receipt/
handoff/enrollment·rollback 누락을 자체 검수한다. bare ulw, LIGHT 문서 작업이며
reviewer gate는 없다. 가재/나희의 보완 요구 반영은 구현 보안 승인 판정이 아니다.
보완 QA evidence는 owner-design-rev evidence의 review.md/publication.md에 기록한다.

설계 보완 상태: 운영자 관리 pin·다섯 검사·legacy0 활성화 gate·거절 시험 요구 명시. 구현/운영은 미실행.
