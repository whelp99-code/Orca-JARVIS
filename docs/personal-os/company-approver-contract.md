# 회사 승인자 공통 계약 v2

상태: **구현 전 계약·fixture만, 운영 승인·실행 활성화 금지**.
TASK-COMPANY-CONTRACT-FIXTURE-20261015 / attempt=a2468740-3266-4957-89ae-8161d60d12eb.
근거: [닫힌 설계 #88, 9fa2f0d](https://github.com/whelp99-code/Orca-JARVIS/blob/9fa2f0d9dc647ee1d3a8dad2626e41900e8dc32e/docs/personal-os/company-owner-approver-design.md).
이 문서는 그 설계를 수정하지 않는다. SB/Python과 JARVIS/TS의 공통 wire를 정한다.
fixture는 `fixtures/company-approver/company-approver-v2.test-only.json` 한 개다.

## 1. 값·직렬화·명령

모든 객체는 아래 열거한 필드만 허용하는 closed object다. 누락/unknown/중복 JSON key,
BOM/잘못된 UTF-8/단독 surrogate를 거절한다. 문자열은 NFC여야 하며 자동 정규화하지 않는다.
객체 key는 이 계약의 ASCII 이름만 사용한다. JSON 값은 null/bool/string/array/object와
`0..9007199254740991` 정수만 허용한다. 소수·지수 표기·음수·-0·NaN/Infinity는 금지한다.
`C(x)` = ASCII key 오름차순 재귀 정렬, array 순서 유지, 공백/마지막 LF 없는 JSON,
UTF-8 인코딩. 문자열은 JSON.stringify와 같은 escape(ensure_ascii=False), `/` 비escape다.
Python은 `json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False)`.
TS는 `canonicalize(x)`다. profile 검증은 직렬화 전 필수이며 JSON 파일의 들여쓰기는 서명하지 않는다.
`H(b)="sha256:"+SHA256(b).hex()`; `D(s)=UTF8(s)+00`(정확히 NUL 한 byte).
digest/지문은 `sha256:<64 lowercase hex>`, 시각은 `YYYY-MM-DDTHH:mm:ss.sssZ` UTC다.

| 객체 | 필수 필드·조건 |
|---|---|
| binding | provider_instance_id, workspace_id(UUID), owner, processor_principal_id, approver_principal_id, approval_policy_version(양의 정수), wire_revision=2, approver_keys |
| approver_keys 원소 | key_id, algorithm="Ed25519", purpose="decision", public_key_fingerprint=H(DER SPKI bytes). key_id 순 정렬, ID·지문 각각 중복 금지 |
| target | provider_instance_id, workspace_id, candidate_id(NFC 비제어문자, 1..2048자), content_digest |
| args | owner, projects(ASCII ID 정렬·중복0·최대128), policy_revision, deletion_sequence, deletion_set_root, processor_principal_id, operations=["accept","reject","mark_processed"], approver_principal_id, approval_policy_version, approval_binding_digest |
| command | schema_version=2, request_id, action="company.candidate.transition", action_level=3, target, args, reversible=false, requested_by, requested_at, expires_at, nonce |

ID는 ASCII `[A-Za-z0-9][A-Za-z0-9._:-]{0,255}`(candidate/UUID/request_id 제외).
binding의 scope/owner/processor/approver/version과 args/target 복사본은 고정 등록과 같아야 한다.
approver != owner/processor, owner != processor; requested_by=args.owner를 유지한다.
대표/Mail/processor key ID와 material은 분리한다. 요청 복사본은 권한 원본이 아니다.
`binding_digest=H(D("second-brain/company-approval-binding/v1")+C(binding))`.
`handoff_key="company-handoff:v2:"+SHA256(D("second-brain/company-handoff/v2")+C({target,args})).hex()`.
`request_id=handoff_key+":"+generation`(양의 safe integer 십진수, 선행0 없음), nonce=request_id.
명령 TTL은 정확히24시간이며 권한 행사 시 `requested_at <= 현재시각 < expires_at`도
별도로 검사한다. 시작 시각은 포함하고 만료 시각은 제외하며, 미래 시작/만료 명령은
24시간 길이가 맞아도 거절한다. C1~C4는 주입된 현재시각으로 이 구간을 다시 검사한다.
`command_digest=H(C(command))`; state/command_digest를 command에 넣지 않는다.
다른 action은 v1 그대로이며 과거 회사 v1 읽기와 새 v2 mutation 권한을 혼동하지 않는다.

## 2. 대표 승인 서명은 봉투 v1 유지

unsigned approval 필드: schema_version=1, receipt_id, request_id, decision="approve"|"reject",
command_digest, signer_principal_id, authenticated_session_id, key_id, algorithm="Ed25519",
issued_at, not_before, expires_at, nonce, max_uses=1, status="issued".
실제 서명 대상은 **`D("orca-jarvis/command-approval/v1")+C(unsigned_approval)`**다.
Ed25519 pure 모드(no prehash)로 서명한다. signature는 64byte 서명의 padding 없는 base64url(86자)다.
approval=unsigned 필드+signature. command 직접 서명/이중 hash/문자열 hex 서명은 금지한다.
receipt의 command_digest가 새 command2 전체를 묶는다. 옛 command1 receipt 이식은 거절한다.
issued_at <= not_before <= 현재 < expires_at, 수명 최대30분, command TTL도 별도 검사한다.
C1은 approve/reject **기록 전** 실제 key principal/ID/purpose/SPKI와 고정 binding,
서명·시간·폐기·최신성을 검증한다. 실패 시 pending 유지·receipt/이벤트/상환0.
C2/C3/C4도 현재 pin/폐기/최신성을 다시 확인한다. 서명이 맞는 것만으로 허가하지 않는다.

## 3. accept/reject 원본 receipt 읽기

processor 전용 operation=`read_transition_receipt`, purpose=`company_memory_receipt_read`.
요청은 `{authority,arguments:Q}`. Q는 candidate_id, handoff_id(전체 command.request_id),
operation="accept"|"reject", transition_request_digest, command_digest, content_digest,
approval_policy_version, approval_binding_digest를 가진다. scope는 authority에서 고정한다.
transition_request_digest는 보존한 **원래** accept/reject arguments(approval 포함)의 요청 hash다.
정확히 `H(D("second-brain/company-memory-request/v1")+C({operation:Q.operation,arguments:original_arguments}))`.
조회 hash는 `H(D("second-brain/company-memory-request/v1")+C({operation:"read_transition_receipt",arguments:Q}))`.
authority v1은 provider_instance_id/workspace_id/principal_id/agent_id/session_id/projects/
policy_revision/deletion_sequence/deletion_set_root/purpose/operation/request_digest/
issued_at/expires_at/nonce/signing_key_id/schema_version=1 및 signature를 갖는다.
기존 `D("second-brain/company-memory-authority/v1")+C(unsigned_authority)` 서명, TTL<=60초,
새 nonce를 사용한다. principal_id는 고정 processor, 만료된 mutation authority 재전송 금지.

정상 응답 필드: schema_version=2, provider_instance_id, workspace_id, selector=Q,
lookup_nonce=authority.nonce, lookup_request_digest=authority.request_digest,
outcome="found"|"not_found"|"evidence_absent", receipt.
found의 receipt는 receipt_id, receipt_digest, operation, state, handoff_id,
receipt_created_at, decision_at, accepted_at을 가진다. accept는 state="accepted",
accepted_at=원본 snapshot 시각; reject는 state="rejected", accepted_at=null,
decision_at=원래 reject 결정 시각이다. decision_at은 원래 결정의 불변 기록이다.
원본 시각이 없으면 evidence_absent/receipt=null이며 현재/issued_at/상환/created_at으로 추정하지 않는다.
not_found는 인증된 정확 조회에 행이 없는 경우만, receipt=null. unknown/timeout은 not_found 아님.
SB는 전체 저장 receipt hash·원래 decision/request를 검증 후 본문 없는 projection만 반환한다.
클라이언트는 축약 projection으로 전체 hash를 재계산했다고 주장하지 않는다.
고정 broker/peer·경로 소유/권한이 검증된 인증 채널 필수; nonce/hash echo 자체는 인증이 아니다.
읽기는 초기화/receipt 생성/accept/reject/상환/등록/삭제를 하지 않는다. reject found는 로컬 거절
증거만 복구하며 mark_processed하지 않는다. 부재/불확실을 성공/재전송 허가로 바꾸지 않는다.

## 4. completion verifier v2

운영자 고정 config=`{schema_version:2,executable,args}`(절대 trusted path, args<=16, private0600).
stdin은 `C({schema_version:2,command,acceptance})` 후 EOF. acceptance는 원래 검증된 SB
5필드 `{receipt_id,receipt_digest,operation:"accept",state:"accepted",handoff_id}`다.
stdout은 로그·추가 객체 없는 `{schema_version:2,state:"completed",request_id,command_digest,
candidate_id,content_digest,acceptance_receipt_digest,effect_digest}`.
모든 ID/hash를 원래 command/acceptance 및 독립 효과 증거와 대조한다. v1 fallback 없음.
shell:false/최소env/10초-SIGKILL/1MiB/stdin 실패 kill·lease 해제 유지.
효과는 request_id+command_digest 기반 멱등 처리, exit0/입력 echo만으로 완료하지 않는다.
완전한 결과 저장·현재 guard 확인 뒤에만 mark_processed, accept만으로 완료 아님.

## 5. 외부 최신성 제공자: 저장소 중립, 준비 전 비활성

이 절은 인터페이스다. 운영 config로 고르는 구현체는 **미설정·항상 거절** 한 개뿐이다.
config는 `{schema_version:2,kind:"unconfigured"}`만 허용하며, 등록/환경변수로 이를 우회하지 않는다.
unconfigured의 read_freshness는 요청 scope/challenge를 그대로 돌려주되
`status:"unavailable",checkpoint:null`이다. reserve_progress/finish_progress는 항상
`{schema_version:2,outcome:"error",code:"COMPANY_FRESHNESS_REQUIRED"}`를 반환하고 기록/효과0.
ready/예약 성공/정상 완료를 반환하지 않는다. fixture에 config와 정확한 거절값을 고정했다.
아래 최신성·진행 조건은 인터페이스의 요구다. 아래 시험 전용 모델을 운영에 연결하지 않는다.
동일 호스트/동일 backup의 enabled 플래그·서로 같은 옛 DB·자체 hash chain은 독립 근거가 아니다.
scope=`{provider_instance_id,workspace_id}`. checkpoint는 아래 closed object다.
`{operational_epoch,approval_policy_version,approval_binding_digest,revocation_sequence,
revocation_root,stores:{jarvis:P,second_brain:P},intent_sequence,intent_root}`.
P=`{receipt_sequence,receipt_root,terminal_sequence,terminal_root,deletion_sequence,deletion_root}`.
sequence는 비감소 safe integer, root는 prefix 전체의 digest다. epoch는 양의 단조 정수다.
receipt에는 accept/reject/mark_processed 원본, terminal에는 최종 receipt/효과 완료,
deletion에는 삭제 intent·진행·완료/tombstone을 포함하며 소실된 사실을 재생성하지 않는다.
같은 sequence/다른 root, 더 낮은 sequence/epoch, 없는 prefix는 거절한다.

제공자는 복원 대상 밖의 고정 신뢰 registry가 scope별 **최신 epoch와 단조 head**를 선택해야 한다.
클라이언트의 epoch/경로/정렬 결과/복원된 config로 최신 값을 고르지 않는다.
epoch 전환은 별도 운영 승인·이전 head 연결·모든 폐기/진행/미확정 intent 보존을 요구하며,
새 epoch가 중복 방지 기록을 초기화해서는 안 된다. 관리자의 삭제/교체/우회도 위협에 포함한다.
무결성 hash/보존된 옛 객체만으로 최신성을 주장하지 않는다. 인증된 고정 제공자 채널과
fresh challenge 응답, rollback 불가능한 현재 head 선택·CAS의 보장이 필요하다.
그 보장을 검증할 수 없는 구현은 ready를 반환하거나 운영을 열 수 없다.

| 인터페이스 | 필수 입력 -> 응답 및 효과 |
|---|---|
| read_freshness | `{schema_version:2,scope,installation_id,challenge,observed_checkpoint}` -> `{schema_version:2,scope,challenge,status:"ready"|"mismatch"|"unavailable"|"uncertain",checkpoint}`. ready만 최신 checkpoint, 나머지는 checkpoint=null. observed는 비교값일 뿐 최신 선택권 없음 |
| reserve_progress | `{schema_version:2,scope,operation_id,operation,expected_checkpoint,event_digest,challenge}` -> `{schema_version:2,scope,challenge,outcome:"reserved"|"already_reserved"|"conflict",checkpoint,reservation_id}` **또는** `CompanyFreshnessRequiredError`. 현재 head에 CAS하여 영구 intent를 **효과 전** append, 원자적 one-winner; 재호출은 실행 권한 재발급 아님 |
| finish_progress | `{schema_version:2,scope,operation_id,reservation_id,expected_checkpoint,evidence_digest,terminal_state,challenge}` -> `{schema_version:2,scope,challenge,outcome:"recorded"|"already_recorded"|"conflict",checkpoint}` **또는** `CompanyFreshnessRequiredError`. 원래 사실/진행만 추가, 모순 결과 덮어쓰기 금지 |

`CompanyFreshnessRequiredError`는 closed object
`{schema_version:2,outcome:"error",code:"COMPANY_FRESHNESS_REQUIRED"}`다.
두 진행 응답은 정상/CAS 분기와 이 오류 분기의 명시적 합집합이다. 오류에는
scope/challenge/checkpoint/reservation_id를 요구하거나 추가하지 않는다.
소비자는 이 유효한 오류를 COMPANY_CONTRACT_INVALID로 바꾸지 않고 원래 코드를
유지하며, 예약·완료로 취급하거나 후속 효과를 실행하지 않는다.

진행 기록의 operation은 decide_approve/decide_reject/accept/reject/complete/mark_processed/delete다.
C1 결정·SB 전이·verifier 효과는 서로 다른 operation이며 호출 경계가 고정한다.
`operation_id=H(D("second-brain/company-operation/v1")+C({scope,request_id,command_digest,operation}))`.
삭제는 같은 domain의 `C({scope,deletion_plan_digest,operation:"delete"})`다.
**epoch/재시도 시각을 넣어 다른 일로 만들지 않는다**.
reserved/already_reserved의 checkpoint와 reservation_id는 원래 durable 기록을 반환한다.
reserve의 conflict는 checkpoint/reservation_id=null, finish의 conflict는 checkpoint=null이다.
어느 conflict도 실행 허가가 아니며 finish 응답에 reservation_id를 추가하지 않는다.
순서: 최신성 검사 -> 독립 reserve_progress durable ack -> 한 번의 효과/불변 로컬 receipt ->
독립 finish_progress durable ack -> 정상 완료 응답. 둘의 DB에 공통 ACID가 있다고 가정하지 않는다.
reservation은 지워지거나 TTL로 자동 해제되지 않고 이전 epoch/복원 후에도 중복을 막는다.
이미 reserved/완료인 작업에는 effect 호출 권한을 다시 주지 않는다. 효과 수신자도 같은
operation_id로 dedup하거나, 재실행 없이 독립 조회로 결과를 증명할 수 있어야 한다.
효과 성공 뒤 외부 finish가 실패하거나 응답이 유실되면 durable intent와 **uncertain**을 유지한다.
로컬 DB에 기록이 없어도 재실행하지 않는다. 실제 원본 receipt/효과를 읽어 조정할 수
없으면 격리·비활성, 재활성화/복구 구현은 오모냥 담당 별도 과제다.
미확정 intent/관련 terminal·삭제 기록은 복원 가능한 backup보다 먼저 만료/삭제할 수 없다.

시작과 매 C1~C4는 정책/키 **및** 해당 store의 receipt/terminal/삭제 진행과 intent를 대조한다.
복원됐거나 증명 불가/오류/불일치/미확정이면 회사 승인·실행은 계속 비활성이다.
receipt-only 읽기는 별도 현재 권한 확인 아래 가능하며 mutation으로 승격하지 않는다.
ready는 운영 활성화 승인이 아니다. 대표의 별도 승인·운영자 검증과 후속 복구 과제가
없으면 재활성화하지 않는다. 이 계약·fixture·제공자 후보 조사는 운영 준비 증명이 아니다.

### TEST_ONLY 메모리 제공자: 성공 경로 시험 전용

논리 구현체 `TEST_ONLY_memory`는 시험 코드에서만 생성·불러오기·주입한다.
factory 입력은 `{scope,initial_checkpoint}`이며 복제한 초기 head와 operation별 map을 가진다.
제품 export/registry/CLI/env/운영 config로 선택할 수 없다. 운영 config의 허용 kind는
여전히 unconfigured 하나이며 TEST_ONLY_memory/테스트 플래그로 우회하면 계약 오류다.
휘발성 메모리는 독립 저장·현재성·복구/운영 준비의 증거가 아니다.

- read_freshness: 고정 scope와 challenge를 echo. observed_checkpoint가 현재 head와
  같으면 ready+현재 checkpoint 복사본, 다르면 mismatch+checkpoint=null.
- reserve_progress: 같은 operation_id의 operation/event_digest/원래 expected_checkpoint가
  모두 같으면 이미 기록한 reservation_id/checkpoint로 already_reserved.
  다른 내용의 같은 ID, 또는 신규 ID의 expected_checkpoint가 현재 head와 다르면
  conflict+checkpoint=null+reservation_id=null. 신규 일치 요청만 원자적 CAS로
  reserved 기록+head를 갱신한다. 같은 head에 동시 신규 요청은 승자 정확히 하나다.
- finish_progress: 원래 reservation_id가 필요하다. 최초 일치 expected_checkpoint만
  원자적 CAS로 recorded. 완료 후 같은 evidence_digest/terminal_state/원래 finish
  expected_checkpoint면 already_recorded+원래 완료 checkpoint; 내용/예약/현재 head
  불일치는 conflict+checkpoint=null. 이미 완료한 내용을 덮거나 효과를 호출하지 않는다.
  서로 다른 예약의 같은 head 동시 finish도 승자 하나다. scope 불일치는 계약 오류다.

시험 모델의 reservation_id는 `"reservation:TEST_ONLY:"+operation_id의 sha256: 뒤 64hex`.
reserve record는 `{operation_id,operation,event_digest,reservation_id,state:"reserved"}`,
finish record는 `{operation_id,reservation_id,evidence_digest,terminal_state,state:"finished"}`.
각 최초 성공만 intent_sequence를 1 늘리고
`intent_root=H(D("second-brain/TEST_ONLY-memory-progress/v1")+C({previous_root,sequence,record}))`
(sequence=새 intent_sequence)로 head를 갱신한다. 나머지 checkpoint 필드는 seed 그대로다.
재호출/conflict/read는 map/head를 바꾸지 않는다. fixture의 case 배열을 순서대로 독립
factory 한 개에 적용하면 ready/reserved/already_reserved/conflict/recorded/
already_recorded/mismatch의 정확한 응답이 나온다.
이는 T7·T17·T11·T18 성공 경로에 주입할 시험 대역 계약이지 그 제품 통합 시험의 실행 결과가 아니다.

## 6. 오류와 미래 통합 시험

오류 wire는 `{schema_version:2,outcome:"error",code}`. 코드로 성공/자동 retry를 유도하지 않는다.
transport 실패/권한 실패/응답 불명을 합쳐 not_found로 처리하지 않는다.

| code | 의미 / 처리 |
|---|---|
| COMPANY_CONTRACT_INVALID | unknown/중복/누락/타입·정규화·canonical profile/version 오류, mutation0 |
| COMPANY_APPROVAL_INVALID | 서명·digest·purpose·principal·pin·시간 불일치, pending/receipt·이벤트0 |
| COMPANY_APPROVAL_REVOKED | 키/승인/binding 폐기, 키 폐기 rollback은 이 별도 경계로 차단 |
| ENROLLMENT_REQUIRED | 고정 등록 불일치/재활성화 미승인, 계속 비활성 |
| COMPANY_FRESHNESS_REQUIRED | 제공자 미준비/인증·현재성 증명 불가/읽기 실패, 시작/C1~C4 비활성 |
| COMPANY_OPERATIONAL_ROLLBACK | **정책·키가 같아도** epoch/receipt/terminal/삭제 진행이 외부보다 뒤이거나 root 불일치, 비활성·replay0 |
| COMPANY_PROGRESS_UNCERTAIN | 예약 이후 효과/외부 완료 여부 미확정, 재실행0·격리 |
| COMPANY_DUPLICATE_OPERATION | 이미 예약/완료된 operation_id, 원본 읽기만·효과0 |
| COMPANY_RECEIPT_EVIDENCE_ABSENT | 원본 receipt/결정 시각 부재·손상, 추정·blind resend0 |
| COMPANY_VERIFIER_INVALID | v1/오염·부분·과대 응답/잘못된 증거/exit·stdin·timeout, mark_processed0 |

1. F1: 양 언어가 fixture binding/command/unsigned approval canonical hex·hash·서명 bytes를
   같게 계산하고 실제 Ed25519 검증. 한 필드/서명/domain 변조는 실패.
   두 진행 응답 parser는 unconfigured의 정확한 오류 wire를 허용하되 정상/CAS 분기와
   혼합한 객체는 거절한다. 명령은 requested_at 직전/정각/만료 직전/정각/이후를 고정
   시각으로 시험해, 24시간 길이만 맞는 미래/만료 명령을 허용하지 않는다.
2. F2(키 폐기 rollback): 키/정책 폐기 뒤 한쪽·양쪽 옛 DB/config 복원, C1~C4 승인·효과0.
3. F3([별도 P1 4278139710](https://github.com/whelp99-code/Orca-JARVIS/pull/88#discussion_r4278139710)):
   **binding/키/폐기 목록을 바꾸지 않고**, backup 뒤 accept·reject·완료·삭제를 각각 실행한
   뒤 양쪽 DB를 그 전으로 복원. 외부 epoch와 receipt/terminal/삭제 highwater 또는 intent가
   복원 상태와 달라야 하며 시작/C1~C4 비활성·기존 효과 재실행0·삭제 부활0.
4. F4: reserve 전 crash는 효과0; reserve ack 유실/효과 후 finish 실패/DB 복원은 미확정
   예약 보존·중복 효과0. 동시 동일 operation_id 승자1, epoch 교체 후에도 dedup 유지.
5. F5: 기준값 누락/옛 epoch 선택/옛 인증 응답 재생/admin 교체/불일치/timeout은 모두 비활성.
   unconfigured는 언제나 unavailable/거절·기록0·효과0이며 ready를 반환하지 않음.
6. F6: 실제 SB accept/reject commit 뒤 응답 유실→fresh readonly lookup, 원본 시각 복구,
   DB mutation0; not_found/불확실을 성공/재전송으로 바꾸지 않음.
7. F7: 실제 verifier child stdin2/EOF/stdout2→검증된 효과/mark_processed; v1·불완전 출력·
   timeout 거절, child 종료/lease 해제. 기존 T1~T18의 나머지 권한·scope 회귀도 유지.

F2~F7은 후속 본체/제공자 구현의 통합 시험 목록이며 이 PR에서 실행한 시험이 아니다.
fixture의 TEST_ONLY private key는 공개 시험 데이터다. 운영 registry/credential에 등록 금지.
