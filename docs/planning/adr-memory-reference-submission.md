# 참고 기억의 한 번 제출과 완료 재검사

상태: 구현 전 결정. 공통 기억 완성 목표의 C7 제출 경계를 기존 reader에 연결한다.

SB의 현재 조회는 정정/삭제를 반영하지만 소비자가 예전에 받은 JSON을 다시 제출하면 과거
내용이 모델에 전달된다. `MemoryReferenceReader`가 발급한 객체에만 적용되는 `submit`을 추가한다.
새 DB·MCP wire·권한·운영 자동 주입은 추가하지 않는다.

- reader는 읽기 당시 privacy snapshot과 provider generation, 정확한 본문 직렬화를 내부에 보관한다.
  WeakMap으로 호출자가 보유한 객체 수명을 따르며 디스크에 원문/이력을 복제하지 않는다.
- 같은 객체의 제출 시도는 한 번이다. provider await 전에 소비하여 동시 호출과 실패 후 자동
  재시도를 막는다. 다른 reader·복사/복원한 JSON·변조 객체는 제출할 수 없다.
- 제출 직전 provider status를 다시 읽고 local privacy/위임/만료·본문 무변경을 확인한다.
  확인과 callback 호출 사이에는 추가 await를 두지 않는다. callback에는 계수된 직렬화 본문만 준다.
- callback 완료 뒤 다시 provider status와 local privacy/만료를 검사한다. 도중 정정/삭제/철회 시
  결과를 반환하지 않는다. callback 실패는 수신 불확실로 정규화하고 같은 객체를 재제출하지 않는다.
- 제출 유효 시간은 provider checked_at에서 최대 60초이며 no_data/record의 더 짧은 만료를
  함께 적용한다. 빈 current/no_data 결과도 무기한 재사용하지 않는다. 긴 모델 요청은 현재
  60초 경로를 넘으면 결과를 제공하지 않으며 장기 세션 인수와 구분한다.
- 외부 모델 요청 중 SQLite transaction을 열어 두지 않는다. provider와 소비자 사이의 전역
  원자적 잠금은 없으므로 status 관측 직후 외부 변경까지 막았다고 주장하지 않는다.
- 반환은 callback 완료와 재검사를 의미한다. native client 수신 확인·영구 receipt·세션 간 중복
  억제·compaction·이미 제출한 데이터 회수의 증거가 아니다. 이 C6/C7 후속은 계속 필요하다.

기존 `memory context` CLI는 읽기 출력 계약을 유지한다. 실제 client 통합은 같은 runtime 안에서
read→submit으로 호출해야 한다. CLI JSON을 직접 모델에 보내는 기존 스크립트는 보호된 제출이 아니다.
실제 두 저장소/모델 인수에서 최신 문맥 제출과 준비 후 정정/삭제 시 callback 미호출을 확인한다.
