# 아침 브리핑의 공유 출처 계약

2026-09-08, P1-12 실제 브리핑 연결의 선행 수정.

## 확인한 문제

`recommendation-projection.ts`는 한 recommendation의 rank별 action을 반환하고 공통 evidence를
재사용한다. `morning-brief-input.ts`는 추천·출처·인용까지 전역 unique로 요구해 이 정상 형태를
거부한다. 유효한 digest로 만든 공유 추천/출처/인용 입력 3개가 모두
`MORNING_BRIEF_INPUT_INVALID`로 실패했다. 기록은 `brief-provenance-red.log`다.

## 결정

- item/action identity와 각 record digest의 재계산·중복 검사를 유지한다.
- 서로 다른 action의 recommendation ID, record 사이의 source ID 재사용을 허용한다.
- link ID는 동일 source ID와 evidence ref의 결합일 때 record 사이에서 재사용할 수 있다.
  같은 link ID의 다른 결합, 한 record 내부의 중복 link/source, 서로 다른 종류의 ID 충돌은 거부한다.
- semantic 병합 후 인용은 link ID별로 한 번만 제공하고 고유 인용 수로 예산·생략 수를 계산한다.
  source 원문 ID를 action마다 새 ID로 바꾸는 우회는 하지 않는다.
- wire schema와 digest 계산은 유지한다. 기존에 유효했던 입력의 산출물은 보존한다.

## 후속 경계

브리핑 산출물을 일일 루프에 저장하는 실제 handler·출처 차단 계보·서비스 연결은 여전히 필요하다.
이 계약 수정만으로 아침/저녁 자동 운영을 활성화하지 않는다. `priority-engine-ranking.ts`,
브리핑 parser, generator의 today 판정이 모두 UTC인 것도 확인했다. KST 일일 운영에 맞추려면
생산자와 소비자를 함께 바꿔 검증해야 하며 이번 공유 출처 변경과 분리한다.

## 검증

같은 추천의 서로 다른 action, 공유 출처/정확 인용, semantic 병합·인용 상한·입력 순서,
상이한 source/evidence 결합, 중복 entity/record 내부 인용, digest 변조를 검사한다.
실제 추천 저장·조회 및 compiled 브리핑→일일 단계 저장→HTTP Today 읽기 경로도 별도로 확인한다.
격리 자료의 계약 검증은 실제 업무 추천 생산·예약 실행의 완료 증거가 아니다.

검증 결과: 관련 6파일25개/8.30초, 타입 배열 수정 후 통합1개와 reviewability2개/3.35초
통과(고유 합계7파일27개). backend build/typecheck/lint exit0, 독립 정적 리뷰 필수 결함0.
첫 typecheck의 readonly 배열 matcher 오류1개는 테스트의 배열 복사로 수정했다.

compiled 비교에서 기존 유효 입력21개(0~20 record)의 canonical 산출물이 변경 전과 일치했다.
실제 SQLite 추천1개/행동3개는 공유 source1개, 인용13회/고유7개로 조회됐다. 이전 parser는
동일 입력을 거부했고 수정 후 owner 항목1개를 생성했다. 테스트용 변환·명시적 DailyLoopStore
저장으로2700bytes를 남기고 DB 재개방 후 byte 동일성을 확인했다. Today HTTP200,
brief.state=degraded/item_count=1, GET DB쓰기0, 임시 DB/서버 제거를 확인했다.
이 fixture 변환은 실제 업무 변환 정책이나 서비스 handler가 아니다.

증거 루트 `/home/jm/.cache/jarvis-test-runtime-qa-20260908/`:
`brief-provenance-{red,green,tests,final-tests,types,types-final,lint,build}.log`,
`brief-provenance-live.mjs/json/log`. 최초 HTTP probe는 brief summary에 없는
canonical_digest를 기대하여 실패했다(`brief-provenance-live-wrong-field.log`). 실제 summary
계약을 대조해4필드 검증으로 고친 뒤 최종 exit0이며 제품 수정은 없었다.

2026-09-08 후속: 위 UTC today 판정3곳은 [서울 날짜 변경](adr-seoul-deadline-calendar.md)에서
생산자와 소비자를 함께 수정·검증했다. 실제 handler와 자동운영 연결의 미완료 범위는 유지한다.
