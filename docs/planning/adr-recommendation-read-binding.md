# 추천 읽기의 원본·행동 결합

2026-09-08, P1-12 브리핑 입력의 선행 조건.

## 발견과 결정

storedRecommendationIdentity는 저장 digest를 identity 계산에 사용하지만 canonical envelope와
evidence를 재계산해 비교하지 않는다. projection과 timeline은 분리 저장된 행동 제목·작업·대상을
원본 추천과 대조하지 않는다. 개인 reader의 task18 판별은 JSON 문자열 공백에 영향을 받는다.
브리핑으로 연결하기 전에 이 읽기 경계를 보강한다.

- 기존 canonicalPersonalContractHash와 evidence hash를 재계산한다. 정상 저장 identity는 유지한다.
- 추천 행의 ID를 envelope ID와 먼저 묶고, 조회에 쓰는 저장 metadata를 원본과 대조한다.
- rank별 행동은 canonical payload와 비교한다. provenance의 material 제출 순서는 rank 순서와
  다를 수 있으므로 ranking.rank → action_id → material로 결합한다.
- 개인 reader는 파싱한 source_version으로 task18을 구분한다. legacy RecommendationV1에
  task18 compressed provenance를 강제하지 않는다.
- projection·개인 reader·timeline은 공통 읽기 검사를 사용한다. owner/pending만 허용하는
  workflow 실행권한 검사를 읽기 정책으로 대체하지 않는다. 과거 ranking도 재계산하지 않는다.
- 읽기 검사는 실패 시 일반 계약 오류를 반환하고 원본 본문을 오류에 포함하지 않는다.

독립 리뷰에서 첫 SELECT와 검증용 재조회 사이에 다른 연결이 값을 복원하면 검증한 행과
반환하는 행이 달라지는 경계를 찾았다. projection·개인 reader·timeline/context의 전체 읽기를
deferred transaction으로 묶는다. timeline overview의 기존 snapshot과 중첩 읽기도 유지한다.

## 검증과 비용

- 최초16개 경계 중11fail/5pass, 별도 두 연결 snapshot 재현2fail을 확인했다. 공백 판별 우회,
  원본과 행의 ID·행동·metadata 불일치, 자체 hash 재계산을 동반한 copy 변경을 검사한다.
- 역순 material 제출, JSON 공백만 바뀐 원본, task18 provenance가 없는 legacy,
  accepted·시간 만료·superseded 등의 기존 읽기를 유지한다. 순서 호환 검사 대신
  canonical serializer를 다시 확인하던 중복 테스트1개는 제거했다.
- 관련12파일64개 실행은63pass/1fail이었다. snapshot 시험이 rank1의 제목을 복원하면서
  다른 두 rank에도 같은 제목을 쓰던 fixture 오류를 수정했다. 제품 snapshot 검증은 이때도
  최초 변조를 거부했고, 실패는 정상 복원 이후 읽기 단계였다.
- workflow·승인·runtime 관련7파일89개/82.55초 pass. 최종 신규 및 snapshot·크기 검사
  3파일20개/4.97초 pass. 중복을 제외한18파일152개가 통과했다. backend build/typecheck/lint
  exit0, 최종 독립 정적 리뷰의 잔여 필수 결함0건. 초기 테스트의 branded ID 타입 오류3개를
  저장 API가 반환한 RecommendationId 사용으로 수정했다.
- 이전 compiled 코드의 별도 프로세스에서 추천1개·행동3개를 저장했다. 변경 제목을 그대로
  반환하는 이전 동작을 확인한 뒤 원복했다. 새 프로세스는 같은 DB에서 projection·개인조회·
  목록·timeline·context 다섯 canonical 결과가 이전과 동일함을 확인했다. 조회 쓰기0.
- 실제 HTTP 추천 상세는 정상200 → 제목 변조 후500, 합성 본문 표식 노출0이었다.
  두 검증용 임시 디렉터리는 제거 후 존재하지 않음을 확인했다.
- 별도 DB의 추천100개·행동300개를 limit500으로 조회한12회 실측은 p50
  49.918→73.481ms, p95 61.547→95.119ms였다. 출력 canonical bytes 동일·쓰기0.
  이 증가는 추가 해시·행·이벤트 검증 비용이며 검색 성능 개선으로 보고하지 않는다.
  제한된 개발 환경 측정이며 대규모 운영 인수 수치가 아니다.

증거 루트: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`.
`recommendation-read-red.log`, `recommendation-read-snapshot-red.log`,
`recommendation-read-contracts.log`, `recommendation-read-workflow.log`,
`recommendation-read-final-targeted.log`, `recommendation-read-typecheck*.log`,
`recommendation-read-build.log`, `recommendation-read-lint*.log`.
실행/비교 도구와 결과는 `recommendation-read-live.mjs/json/log`,
`recommendation-read-before.json/log`, `recommendation-read-perf.mjs`,
`recommendation-read-perf-before/after.json/log`다.

이 변경은 저장 원본과 파생 행의 불일치 탐지다. 저장소 전체를 다시 쓰고 모든 digest를 재계산한
공격자의 입력을 증명하는 서명은 아니다. 출처 본문·절대 기한·현재 삭제 상태를 확인하는 브리핑
mapper와 자동 저장은 별도 완료 조건이며 이 문서만으로 활성화하지 않는다.

source의 고정 생산자 식별자·정책/생성 시각의 의미, context evidence와 실제 원문·절대 기한의
결합까지 검증한 것으로 확대 해석하지 않는다. 해당 입력 mapper와 브리핑 자동 저장 HOLD를 유지한다.
