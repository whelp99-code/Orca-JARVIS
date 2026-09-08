# 범위 요청 준비와 불변 파일 발행 조합

2026-09-09. `publishMemoryScopedWriteRequest`는 기존 prepareMemoryScopedWriteRequest와 MemoryScopedWriteSpool을 명시적 제품 API로 조합한다. 기존 private root·인증 범위 resolver·clock이 필요하며 운영 CLI에 자동 연결하지 않는다.

IMMEDIATE transaction 안에서 현재 원본 권한·범위 검토·정책으로 요청을 생성하고, codec을 거쳐 파일을 발행한다. 파일 작업 후 준비를 재실행하여 같은 canonical 요청인지 검사한다. 파일을 다시 읽어 key/provider/bytes를 대조하고 반환 직전 시각으로 만료를 재검사한다. clock의 NaN/역행은 거부한다. 반환은 schema4/kind prepared/writes_authorized false와 파일/요청 식별자다. 승인 단일 소비·outbox enqueue·provider 접수가 아니다.

발행 후 검증 실패는 성공을 반환하지 않지만 파일은 남길 수 있다. 파일만으로 권한을 부여하지 않으며, 이후 같은 현재 권한으로 재시도하면 정확한 bytes만 재사용한다. 다른 자료로 덮어쓰지 않는다. 단일 소비·outbox 확정은 이 조합 뒤에 여전히 필요하다.

검증: 최초19통과 후 최종 read 도중 만료 검증을 추가해 관련20 passed/10.48초. 정상 replay/DB 불변, 발행 후 철회·만료·역행·변조·read 후 만료 거부를 검증했다. 최종 타입/변경 파일 ESLint/격리 emit 통과. 실제 CLI fixture와 서명된 owner review/private 정책 파일을 사용해 독립 Node3개에서 발행 후 exit73→동일 bytes/inode 재시도→정책 agents 제거 후 거부를 확인했다. DB 행 수 불변/provider0/outboxfalse였다.

실제 모델 세션·운영 provider 인수, 실패 파일의 보존/삭제 inventory, 승인 소비 및 outbox 원자적 확정·v4 공개 계약과 영수증 소비는 미완료다. 이 API의 prepared를 accepted/proved로 취급하는 방식은 보류한다. 운영 DB/서비스/설정은 변경하지 않았다.

## 최종 파일 읽기 이후 철회 재검사

같은 날 후속 검증에서 최종 spool.read가 정책 철회와 겹치면 만료만 확인하고 prepared를 반환하는 회귀1개를 재현했다. 최종 파일 확인 뒤에도 기존 prepare 경로를 다시 실행해 현재 정책·원본 권한·범위 검토와 동일 요청 bytes를 확인하도록 수정했다.

관련23 passed/12.53초, 타입·변경 파일 ESLint·격리 emit 통과. 추가로 read 도중 정책/원본 verification/범위 검토 철회3경우를 검증했다. 테스트에서 같은 transaction에 주입한 DB 철회는 실패 시 rollback되므로 독립 운영 철회 인수로 보고하지 않는다. 별도 Node4개 인수에서는 실제 private 정책 파일의 agents를 최종 read 직후 제거해 MEMORY_SCOPED_WRITE_POLICY_INVALID를 확인했다. 파일 정책 철회는 DB rollback과 무관하게 남았고 후속 프로세스도 거부했다. 기존 bytes/inode·DB 행 수 보존/provider0을 유지했다.

이는 준비 결과 반환의 해당 경계에 대한 검증이다. 승인 소비/outbox 원자적 확정·실제 provider 권한·운영 모델 경로의 완료 증거는 아니며 기존 잔여 조건을 유지한다.
