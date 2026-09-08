# 일일 보고서 생성·저장·조회 연결

- 날짜: 2026-09-08
- 범위: 개선 목록12의 실제 아침·저녁 보고서 연결. 전체01–25 목표를 유지한다.
- 상태: 구현 중. 운영 활성화와 일일 보고서 전체 인수는 미완료다.

## 확인한 경계

DailyControlLoop는 morning_reconcile/evening_summary에 no_external_effect를 저장한다.
MorningBrief generator와 EveningCloseoutStore는 존재하지만 실제 운영 입력 조립기와
서비스 연결은 없다. Today는 아침 보고서의 최상위 digest와 배열만 검사한다. 내부 항목,
출처 digest, brief ID, 생성 시각과 run의 날짜 결합을 검증하지 않는다. 저녁 조회는
artifact가 제공한 공개키를 그대로 사용하므로 별도의 신뢰 키 공급도 필요하다.

## 구현 순서와 결정

1. 아침 보고서의 저장 결과를 검사하는 공통 verifier를 제공한다. 입력 parser와 기본
   값 검사를 공유하고 닫힌 객체, 항목/출처/최상위 digest, ID 결합, 분량, 인용 범위와
   섹션 의미를 검사한다. Today는 이 verifier 및 daily run 무결성·날짜를 확인한다.
   같은 semantic key의 정보/행동/대기 섹션이 충돌하면 해당 묶음을 conflicting으로 제외한다.
   서로 다른 확정 마감일도 conflicting으로 계수한다. 마감일 미상(null)은 충돌이 아니다.
   대표 항목의 정렬만으로 추론된 행동을 확인된 FYI에 합치거나 대기 상태를 잃지 않는다.
   이 검사는 서명이나 원본 사실의 진위 증명이 아니다. 출처의 권한과 유효성은 생산자가
   기존 context/recommendation 경로에서 검증해야 한다.
2. 실제 context/recommendation/검증 결과를 읽는 생산자를 연결한다. 원문·우선순위를
   fixture 기본값으로 대체하지 않는다. 입력이 없으면 명시적 no_data 산출물을 만든다.
   생산자 미구성은 no_data와 구분하고 실패로 정산한다.
3. 기존 lease/fence와 step transaction에 실제 사용량 및 삭제 추적을 결합한다.
   영속 예산 변경은 새 migration으로 적용하고 이미 배포한 SQL은 수정하지 않는다.
   저녁 step 정산을 분리하되 기존 settle 호출의 멱등 의미를 유지한다.
4. 기존 service에 구성하고 놓친 일정·재시작·중복 실행·삭제·실제 UI를 검증한다.

각 단위를 검증·커밋하며 미완료 단계는 계속 진행한다. 새로운 scheduler/기억 DB를
만들거나 placeholder를 정상 artifact로 허용하지 않는다. 이미 저장된 placeholder는
실제 보고서로 표시하지 않는다. 배포·재시작·운영 DB 변경은 기존 운영 경계를 따른다.

## 완료 증거

실제 cycle/startup → 출처 있는 생성 결과 → 동일 DB 재개방 → Today 조회를 확인한다.
예산·lease/deadline의 경계 전후, 단계 저장 직후 종료, 새 fence의 복구, 삭제/정정 이후
비노출, 신뢰 키 불일치와 위조 결과의 쓰기0을 검증한다. 테스트 성공만으로 운영 활성화나
실제 업무 결과 수집 완료를 선언하지 않는다.
