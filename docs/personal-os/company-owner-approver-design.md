# 회사 후보 owner 모델 불일치 해결 설계

TASK-COMPANY-OWNER-MODEL-DESIGN-20261015  
attempt=9eaf3e68-6614-45a4-a3d1-5a8f33d65b61

**추천: B — 기존 후보의 데이터 owner는 보존하고, 정책에 고정된
`approver_principal_id`를 별도로 두어 대표 결정 권한을 묶는다.**
후보 자체를 재소유시키지 않고, 기존 handoff와 enrollment가 있다면
감사 가능한 명시적 전환을 수행한다. 단순 config 변경이나 DB UPDATE로 해결하지 않는다.
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
| 24/N 보존·이행 | 후보 행·access.owner·source/content digest·state를 그대로 보존하므로 후보 재작성 없음. 승인 policy/enrollment/handoff가 존재할 때 그 레코드만 명시적으로 이행. source access policy_revision을 승인 정책 개정 번호로 바꿔 기존 scope를 깨지 않음 |
| 코드 범위 | 양쪽 policy/context/strict arguments/digest 계약, JARVIS62/139/217의 비교 대상, SB270의 비교 대상 및 policy equality 검사, importer/transport/context binding, 저장된 handoff·등록의 전환, UI owner/작성자/승인자 표시 |
| 시험 | 대표 허용, 비대표·processor·mail-ms·principal/key spoof 거부; approver만 변조한 digest/교차 workspace/revoked key/누락 필드 거부; candidate가 전혀 변하지 않음; pending/approved/redeemed 및 등록 전환·재시도·동시성 |
| 되돌리기 | 새 결정 상환 전에는 신규 binding/수입을 정지하고 candidate는 그대로. 새 결정이 상환된 뒤는 기록 보존·전진형 policy epoch; 구 바이너리를 새 DB에 쓰게 하거나 enrollment를 삭제해 “복귀”하지 않음 |

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
C의 append-only manifest/명시적 전환 원칙만 B의 handoff·등록 이행에 적용한다.

## 4. 추천 B의 구체적인 권한 모델

| 축 | 값/근거 | 유지할 권한 |
|---|---|---|
| 데이터 owner | 기존 candidate.access.owner / principal:mail-ms | 기존 owner/project/access policy/deletion scope |
| 작성·요청 주체 | 인증된 Mail/ordinary authority key와 source provenance | 수신/등록/명시적 handoff만, 인간 결정 금지 |
| approver | 정책에 고정된 principal:owner + purpose decision의 허용 key IDs | policy scope 안의 대표 approve/reject |
| processor | 별도 principal:company-candidate-processor + 별도 material | 실제 대표 receipt를 전달하고 검증된 완료만 수행 |

최소 변경은 CompanyHandoffPolicy와 ControlArguments에 required approver principal을
추가하고 같은 값이 enrolled binding·JARVIS context·서명된 command digest에 들어가게 한다.
검사 순서는 다음 **설계 불변식**을 만족해야 한다:

```text
command.owner == candidate.access.owner                      [데이터 경계 유지]
command.approver == fixed_enrolled_policy.approver             [caller 선택 금지]
receipt.signer_principal == command.approver
trusted_decision_key.principal == command.approver
receipt.key_id in pinned_approver_key_set
approver != processor; approver != authenticated_handoff_principal
signature + exact command/request digest + purpose + revocation
+ expiry/not_before + one-use/redemption + project/deletion fences [기존 유지]
```

소스의 requested_by==owner 검사를 approver==requested_by로 바꾸지 않는다.
요청자/데이터 주체와 승인자는 원래 다르다. 다른 개인·daily/control action의
owner guard를 전역적으로 약화시키지 않고 company action 분기만 바꾼다.
단순히 “decision purpose인 아무 key”를 허용하지 않는다. 기존 jm-owner root도
principal:owner binding의 허용 대표 key와 같다고 간주하지 않는다.

### 첫 policy는 누가 인가하는가

**새 구현이 필요한 부분이다.** 현재 enrollment 일반 키만으로 임의 approver를
새 trust root로 임명하게 하면 안 된다. 이미 등록된 대표 decision trust root가
company scope의 approval binding을 인가하는 별도 관리 ceremony를 제안한다.
여기에 provider/workspace/data-owner/approver/key-ID·공개 fingerprint/processor,
binding revision, 기존 access policy·deletion fence, nonce/expiry를 묶는다.
SB는 사전에 pin한 동일 대표 공개키와 binding 증거를 검증하고 ordinary enrollment는
인가된 binding만 materialize한다. 미등록 caller 제공 key를 그 자리에서 trust하지 않는다.
실제 대표 서명/정책 인가는 이 문서에서 실행하지 않았다.

이 관리 ceremony는 현재 candidate transition guard를 우회해 사업 후보를 승인하는
명령이 아니라, 새 프로토콜의 제한된 정책 인가 단계다. 정확한 새 action/API/receipt
이름은 후속 구현 설계에서 정하며 이미 존재한다고 주장하지 않는다.
데이터 권리와 실제 회사 scope를 변경하는 grant는 별도의 정본 권리 확인이 필요하다.

### wire·digest 개정 선택

현재 회사 contract는 strict v1 args, `company-handoff:v1` ID와
`second-brain/company-handoff/v1` domain을 사용한다. 그 bytes에 approver를
뒤늦게 붙여 기존 receipt를 유효하게 만드는 것은 금지한다.
추천 rollout은 **회사 전용 새 binding/wire revision 및 ID/hash namespace**를
승인된 계약 개정으로 명시하고 양쪽을 함께 배포하는 방식이다.
범용 control approval receipt의 signature envelope 자체는 기존 v1을 유지할 수 있다.
그것이 새 command digest를 서명하므로 기존 receipt와 섞이지 않는다.
frozen MCP/scoped transport profile이나 그 sidecar를 이 문제 해결에 임의 변경하지 않는다.
구 v1 request는 history display/진단용만 읽고 새 binding의 mutation에는 사용하지 않는다.
approver 누락 시 owner fallback을 두지 않는다.

## 5. 기존 handoff·등록·후보의 이행

아래는 **미구현 전환 절차의 설계**다. 기존 row를 삭제해 재수입하거나
`ON CONFLICT DO NOTHING`을 몰래 UPDATE로 바꾸는 운영 요령이 아니다.

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
후속 코드에는 immutable historical handoff와 audit mapping/current revision이 필요하다.
SB outbox PK(workspace,candidate)와 decisions PK가 이를 제한하므로 schema·store 변경을
포함하고, JARVIS에도 old/new/current 관계를 보존한다.
shipped SQL 수정이 아니라 새 migration으로 구현해야 한다.

SB DB와 JARVIS DB 사이에 하나의 ACID transaction이 있다고 가정하지 않는다.
각 DB 안의 전환은 원자적으로 하고, 공통 transition ID/old-new digests/
binding epoch/상태/ack를 durable하게 기록해 uncertain ack 이후 재개한다.
재시도는 그 transition ID에 idempotent하며 이미 소비된 결정을 두 번 실행하지 않는다.
새 request 생성 전에 구 request의 mutation capability가 비활성화됨을 확인한다.

모든 기존 writer/processor를 새 guard가 있는 버전으로 정렬한 뒤 활성화한다.
구 writer가 새 DB의 상태 전환을 우회할 수 없도록 schema/runtime compatibility도
검증한다. 데이터 access.policy_revision은 그대로 보존하고 승인 binding 개정 번호를
그 필드 대신 사용하지 않는다. deletion high-water mark는 단조 증가한다.
후보 전건 manifest는 원본 IDs/digest/state/scope/fence를 비교하고 뒤늦은 유입을
다음 cohort에 포함한다. 작성자 정보는 인증된 원본 provenance에서 가져오며 추측하지 않는다.

**선행 준비에 대한 정정:** 제공 분석의 “오늘 준비에 등록했다면 재등록”은 조건문이다.
실제 01~05는 등록하지 않았으므로 해당 snapshot에 재등록 부채는 없다.
다만 이후 다른 실행으로 등록/수입됐다면 위 상태별 절차를 적용한다.

## 6. 후속 구현 범위와 시험 인수 조건

| 범위 | 변경/회귀 확인 |
|---|---|
| JARVIS company-candidate-contract / context·transport·import | required approver/binding·새 digest/ID, owner/source/access 값 보존, caller override 거부, 동일 export idempotency |
| JARVIS control-plane62 / execution139·217 | 회사 action의 signer·key principal을 fixed approver와 비교; 타 action owner guard는 동일; accept/reject와 completion 모두 |
| JARVIS owner inbox/read model/store | 데이터 owner·작성자·대표 approver를 별도 표시, receipt 실제 signer를 owner로 위장하지 않음; historical request/current 상태 |
| SB CompanyHandoffPolicy/ControlArguments/enrollment_context | required field·분리된 policy binding, role/key material disjoint, scope/deletion 유지, 명시적 epoch 전환 |
| SB prepare_handoff/authorize_transition/store | identity/digest, old/new handoff map, current uniqueness, original receipt·terminal state 보존 |
| 두 DB migration·release gates | 새 migration·backup/clone rehearsal·compatibility, 2DB 재개/uncertain ack/old writer 차단 |
| Mail producer | B에서는 후보 owner 재작성 없음. 기존 receive-only/source 계약과 provenance 유지 여부를 회귀 확인 |

새 시험은 기존 company 단위/통합 시험군에 추가하고 각 거절 원인을 독립적으로 검증한다.
이 문서에서는 시험 실행·키 생성·가짜 또는 실제 owner 서명을 하지 않았다.

| 시나리오 | 후속 구현의 이진 인수 결과 |
|---|---|
| fixed 대표 key/principal로 같은 provider/workspace/candidate/digest 승인 | accept/reject 성공, 원래 실제 signer 기록 |
| 다른 대표/legacy jm-owner/non-decision key | 거부 |
| processor key 또는 mail-ms/ordinary handoff key의 승인 | 거부 |
| approver 값만 바꿈/키 principal 위장/다른 workspace·projects·binding | signature/digest/policy 경계에서 거부 |
| approver 필드 누락, v1 receipt를 새 request에 복사 | 거부; owner fallback 없음 |
| revoked/expired/not-yet-valid key·receipt, nonce/digest 변조 | 기존 거절 유지 |
| 정상 owner=mail-ms 후보 export 및 requested_by | data owner/requester 그대로, scope filter 통과 |
| 24/27/0/N 후보 및 concurrent receive | 전건·원본 bytes/digest/state/fence 보존, 누락·중복 0 |
| pending handoff의 정책 전환과 crash 전후 재시도 | audit mapping 1개/active subject 1개, old mutation 불가 |
| approved 미상환 vs 상환/ack 불확실/terminal | 새 승인 필요 또는 격리, 이중 effect/상태 회귀 0 |
| 이미 등록된 context·policy 변경 | 암묵적 upsert/unenroll 금지, 승인된 명시적 epoch만 |
| mark_processed에서 approver/binding/원래 receipt/실제 완료 증거 | 올바른 경우만 성공; accept만으로 완료 금지 |
| 개인 memory/daily/다른 company scope·Mail receive-only | 기존 권한/격리 불변 |

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

남은 설계 승인 항목은 첫 approval-binding ceremony의 관리 권한·보관 형식과
회사 전용 wire revision의 계약 pin이다. 문서는 그 경계를 정했지만 구현·대표 동의·
운영 실행을 대신하지 않는다. 회사 자체의 법적 data owner를 바꾸는 요구가 생기면
A/C를 별도 권리 이행 과제로 결정한다.

## 검수와 종료

사용자 제공 조사 + 세 named 파일의 좁은 행 인용 보완 + 독립 architect의
신규 권한/이행 위험 비교를 통합했다. 코드 조사 중복과 전체 AST/DB 재조사는 하지 않았다.
Raw GitHub URL은404였으며 authenticated contents 조회로 필요한 인용만 보완했다.
secret-bearing download URL/token은 문서에 보존하지 않았다.
pure prose이므로 새 test·코드 helper·제품 build/run을 만들지 않고 QA-by-read했다.
읽기 전용 source ref와 source checkout 보존, 문서 범위·금지 우회·N건/receipt/
handoff/enrollment·rollback 누락을 자체 검수한다. bare ulw, LIGHT 문서 작업이며
reviewer gate는 없다. evidence는 별도 design-review.md에 기록한다.

TASK-COMPANY-OWNER-MODEL-DESIGN-20261015_DONE 후보 owner 보존·정책 고정 approver 분리(B), 감사 가능한 handoff·등록 이행 추천
