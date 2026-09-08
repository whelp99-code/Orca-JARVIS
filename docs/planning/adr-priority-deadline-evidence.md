# 추천 결과의 정확한 마감 근거 보존

- 날짜: 2026-09-08
- 범위: 개선 목록12 실제 보고서 생산자의 선행 데이터 계약. 생산자·서비스 연결 완료 아님.

## 실측 결함

기존 PriorityEngineResult v1은 deadline bucket과 citation ref만 저장한다. 동일 근거에서
2026-08-28T13:00:00.000Z와14:00:00.000Z를 입력하면 둘 다 today이고 결과 바이트가 같다.
추천 provenance에 해당 결과를 저장한 뒤에는 실제 시각을 구별할 수 없다.

## 결정

기존 rankPriorityActions와 v1 결과는 유지한다. rankPriorityActionsWithDeadlineEvidence는
같은 평가·정렬 경로에서 v2를 만들고 모든 결과 action에 대응하는 deadline_evidence를
같은 순서로 제공한다. 각 entry는 action_id 및 원래 deadline의 due_at/evidence_ref/
observed_at/fresh_until, 또는 마감 없음(null)을 갖는다. 기권한 후보의 근거도 보존한다.

공통 parser는 v1/v2를 구별하고 정확한 필드 집합·순서·개수·시간·bucket·citation을 검사한다.
rank가 있는 deadline은 생성 시각에 fresh이며 유효한 citation에 연결되어야 한다.
bucket 판정은 생성기와 같은 함수이며 서울 날짜/7일/overdue 경계를 재사용한다.
v1에는 필드를 채워 넣지 않아 기존 provenance digest와 identity가 달라지지 않는다.

Recommendations.create와 저장/복원은 기존 공통 parser를 통해 v2를 수용한다. 별도 테이블이나
migration은 없다. 추천 canonical envelope의 압축 provenance 안에서 마감 근거도 digest에
포함된다. 동일 입력 replay와 v1/v2 공존, DB 재개방 후 복원과 읽기 쓰기0을 검증한다.

## 의미와 남은 연결

이 계약은 평가기에 들어온 값을 손실 없이 보존한다. 평가기의 입력 시각이 현실의 원문과
같다는 증명이나 새 실행 권한은 아니다. 실제 생산자는 원본 정규화 사실의 digest와 시각을
확인하고 기존 context/recommendation 삭제·정정 수명을 적용해야 한다. 기존 v1의 정확한
마감은 unknown이며 임의 복구하지 않는다. v2의 사실도 생성 시각 이후에는 다시 freshness와
deadline bucket을 평가해야 한다. 이 단위에서 아침 생산자나 운영 서비스를 활성화하지 않는다.

## 검증

`/home/jm/.cache/jarvis-test-runtime-qa-20260908/`:

- priority-deadline-tests-first.log: 신규2파일15개 통과,3.32초.
- priority-deadline-regression.log: 기존 우선순위·추천·가독성 포함11파일78개 통과,11.90초.
- priority-deadline-{lint,types,build}.log: exit0.
- priority-deadline-live.mjs/json: 별도 Node 프로세스 재개방, 추천3개·정확한 마감 근거 복원,
  identity/replay 일치, 읽기 DB쓰기0. 합성 근거를 사용하는 격리 인수다.
- 독립 native 리뷰 priority_deadline_review: ship, 추가 finding0. 요청 gpt-5.6-terra/high,
  실현 모델/effort는 반환 메타데이터에서 관측할 수 없다.

브리핑 후보66ef603의 별도 최종 리뷰는 섹션 membership이 항목 digest에 결합되지 않아
fix-first다. 이 수정과 전체 daily 인수는 후속이며 v2 근거 보존 검증으로 대체하지 않는다.
