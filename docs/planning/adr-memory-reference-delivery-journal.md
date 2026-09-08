# 참고 문맥 전달의 영구 시도 원장

상태: 구현·격리 인수 완료, native session adapter/운영 채택 미완료.
`MemoryReferenceReader.submitInSession`으로 객체 한 번 제한을 프로세스/재시작 경계로 확장한다.
기존 `submit`은 객체 단위 보호 API로 유지하며 세션 원장을 사용하는 API와 이름을 구분한다.

기존 AuthorityDb에 personal_context_reference_identity/sessions/attempts를 추가한다. 별도 기억 DB나
평문 본문·질문·source/record ID를 저장하지 않는다. 기존 private projection key의 membership
HMAC을 domain-separated 입력으로 재사용해 session/epoch, record-set, payload, provider
generation/privacy binding을 식별한다. HMAC은 익명화 주장이 아니며 기존 관리형 context
surface의 보존/백업 범위에 포함한다.

실제 client adapter가 관측한 client/session/epoch를 제출 API에 명시한다. 임의 CLI 문자열을
native compaction/접근 권한으로 해석하지 않는다. 같은 session/epoch의 동일 record 집합은
새 payload의 prepared_at이 달라도 중복 제출하지 않는다. 한 session에는 동시에 한 시도만
있고 dispatching/unconfirmed가 남으면 새 객체/epoch로도 우회하지 못한다. 타이머나 재시작을
근거로 불확실 시도를 자동 재전송하지 않는다.

상태 `callback_completed`는 제출 callback 완료 및 reader 사후 재검사의 성공이다. native
모델 확인·답변 근거 사용·작업 성공과 동일하지 않다. 별도 session receipt adapter가 필요하다.
빈 결과도 시도 키를 갖는다. callback 결과/원문은 원장에 넣지 않는다.

기존 memory_read_revision과 tombstone chain이 변경되면 트리거가 기존 session/attempt를
같은 DB transaction에서 invalidated로 만든다. 이후 generation/privacy binding 불일치도
해당 session을 영구 무효화한다. 보수적으로 관계없는 정책/세대 변경도 세션 폐기를 요구한다.
세션별 출처 의존성이 준비되기 전, 새 context를 재조회하면 기존 모델 문맥이 지워졌다고
가정하지 않는다. invalidated session ID는 다른 epoch로 재개할 수 없다.

새 session은 실제 클라이언트가 새로 만들어야 한다. 같은 session의 새 epoch는 연결부가
실제 compaction을 관측한 경우만 제공한다. DB API 자체는 native event parser가 아니다.
임의 epoch 증가로 재전송을 허용하는 전역 자동 주입을 도입하지 않는다.

원장은 기존 personal_context 접두사 scanner와 fresh-authority 복사 경로에 포함한다.
무효화된 session tombstone은 복원/compaction 후에도 보존하여 이전 이력 부활을 막는다.
과거 백업이 외부 제출보다 앞서면 제출 유실을 알 수 없으므로 복원된 원장으로 기존 native
session을 재개하지 않는 운영 규칙/인수가 필요하다. 이 구현으로 전체 DR 완료를 주장하지 않는다.

검증: SQLite 동시 연결, process 종료 뒤 동일 session 재시도, callback 실패/키/삭제 경합,
다른 prepared_at의 동일 record, 실제 두 runtime 및 모델 callback과 영구 상태 대조.


추가 확정 경계:

- singleton key_binding을 최초 claim과 같은 transaction에서 고정하고 이후 모든 원장 API에서
  membership key를 대조한다. 다른 key와 기존 행이 있는데 binding이 없는 상태는 차단한다.
  의도한 key 회전·이전 native session 재개를 지원하는 운영 migration은 이번 범위에서 보류한다.
- dispatching은 dispatch 시도가 영구 기록됐고 종료가 확인되지 않았다는 뜻이다. 실제 송신 중인지,
  프로세스가 종료됐는지는 증명하지 않는다. 이 상태는 재시작 후에도 불확실로 취급해 재전송을
  차단한다. 다른 프로세스의 활성 시도를 타이머만으로 종료/재시도로 바꾸지 않는다.
- 개인정보/삭제 transaction은 모든 기존 세션을 무효화하고 binding/epoch/record-set/payload
  HMAC을 NULL로 지운다. 세션 HMAC과 무작위 attempt ID는 재개 방지 marker로 보존한다.
  새 파일 복사에서 지워진 8개 token의 byte 부재를 실제 확인했으며 기존 파일·백업·모델 사본의
  일괄 물리 삭제를 의미하지 않는다. HMAC도 보존 대상 메타데이터다.
- updated_at은 앱 시각 및 trigger의 SQLite UTC 시각 중 큰 값을 사용해 뒤로 가지 않는다.
  실제 외부 전달 시각·정확한 삭제 시각·삭제 원인의 증명이 아니다.
- claim/finish의 immediate transaction 안에서 최신 로컬 개인정보·권한·만료를 다시 검사한다.
  DB commit과 외부 callback 사이에는 전역 원자적 잠금이 없다. 그 직후 다른 프로세스가 삭제하면
  이미 전송된 bytes를 철회할 수 없다. native adapter의 수신 fence/세션 폐기 계약이 남는다.
- callback_completed는 native confirmation이 아니다. 새로운 epoch의 정당성도 DB API가
  증명하지 않는다. 실제 앱 연결부는 관측한 native session/compaction 정보를 제공해야 한다.

검증 결과: 관련 6파일 90 passed, 추가 upgrade/clock 포함 집중 14 passed, backend tsc/변경
ESLint 통과. 격리한 6개 실제 Node 프로세스로 성공 후 재시작 중복, callback 중 SIGKILL 후
재시도, 키 교체, 개인정보 무효화 후 fresh-file 재개 거부를 확인했다. 실제 SB MCP 및 native
Codex 모델 5회 제출은 합성 adapter session ID로 원장 상태를 검증했다. native session ID
연결·compaction 검증은 아니다. 자세한 증거는 세컨드브레인의
`REFERENCE-DELIVERY-JOURNAL-ACCEPTANCE-2026-09-08.md`를 참조한다.
