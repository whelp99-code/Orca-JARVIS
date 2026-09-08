# 아침 브리핑 항목의 구역 결합

2026-09-08. 아침 브리핑 저장 산출물 검증의 후속 수정.

## 문제와 결정

기존 산출물은 항목에 원래 분류를 보존하지 않았다. FYI 항목을 waiting으로 옮긴 뒤
바깥 digest만 다시 계산하면 개별 항목의 검증을 통과했다. 독립 리뷰에서 이 사례를
`fix-first`로 판정했다.

각 항목에 `reporting_class: action | waiting | fyi`를 보존하고 항목 canonical digest에
포함한다. 생성자는 기존 분류 함수를 사용한다. 검증자는 needs_you_first=action,
waiting=waiting, fyi=fyi 일치를 요구하고 기존 시각·출처·구역별 조건을 함께 검사한다.
원본 계보만 담는 provenance digest의 범위는 바꾸지 않는다.

## 버전과 호환성

- 입력 schema_version은 1을 유지한다.
- 출력 schema_version은 2, brief_id 접두사는 `morning-brief:v2:`로 변경한다.
- semantic_key의 안정적인 식별자인 item_id는 `brief-item:v1:`을 유지한다.
- 구역이 결합되지 않은 v1 산출물은 `MorningBriefIntegrityError`로 거부한다.
  과거 출력의 배열 위치에서 reporting_class를 추정하여 승인하지 않는다.
  v1 산출물이 필요한 소비자는 원본 입력에서 v2를 다시 생성해야 한다.
- 기존 정확한 `no_external_effect` placeholder의 Today no_data 처리는 유지한다.
- 운영 데이터 수정, shipped migration 변경, 운영 배포는 수행하지 않는다.

## 검증과 범위

세 분류 각각을 다른 두 구역으로 이동해 바깥 해시를 재계산한 경우와, 이동하면서
reporting_class만 바꾸고 항목 해시는 유지한 경우를 모두 거부하는 회귀를 추가했다.
구형 출력 형식도 거부한다. 기존 생성·파싱·출처·저장 읽기 회귀를 함께 실행한다.

compiled HTTP와 재개방한 격리 SQLite 검증 8개에서 정상 action/FYI, no_data,
legacy placeholder는 HTTP 200, 이동·분류 변조·형식 오류·다른 날짜는 HTTP 500이었다.
모든 조회의 DB 쓰기는 0건이고 임시 DB는 제거했다. 대시보드 빌드 누락으로 최초
HTTP 실행은 ENOENT였으며 build:dashboard 후 동일 스크립트가 exit 0으로 완료됐다.
증거: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/morning-section-http-live.mjs`,
`morning-section-http-live.json`.

이 검증은 구조·무결성·생성 시점 조건을 확인한다. 모든 해시를 다시 만드는 주체의
출처 진실성을 인증하거나 실행 권한을 부여하지 않는다. 실제 업무 출처 변환,
삭제·권한 계보 결합, 서비스의 자동 브리핑 생산은 별도로 완성해야 한다.

최종 관련 검증: lint/typecheck exit 0, 10파일84테스트/8.81초 통과.
v1 회귀의 brief_id도 실제 v1 접두사로 보강한 후 항목 검증41개/0.355초 재통과.
기존 통합본8c37e5f의 전체 verify는 backend2776/dashboard246, exit 0,
검증 전후 추적 파일 변경0개였다. 해당 전체 실행은 이번 변경 이전의 근거이다.
