# 취소 결과의 자비스 원장 결합

현재 provider_local_suppression 결과에는 기존 70개 표면 compaction 계약이 요구하는 provider40 표면 manifest가 없다. 그 결과를 기존 manifest로 위장하거나 cursor를 먼저 넘기는 경로는 보류한다. 로컬 범위와 provider 결과의 결합 검증을 별도로 구현해야 한다.

선행 단계로 migration073에서 실제 provider 결과를 기존 AuthorityDb에 불변 저장한다. 저장 시 현재 DB에 등록된 provider/release별 공개키와 철회 상태, 서명 시각의 유효 기간을 대조한다. 원래 의향은 발급 당시의 과거 키로 검증하며 재서명/TTL 갱신하지 않는다. 정확한 원 요청·삭제 chain·후보 억제·의향/source binding과 일치해야 한다.

저장과 응답 유실 뒤 조회는 같은 bytes를 반환한다. 조회도 현재 provider 키의 철회를 다시 확인한다. 본문 없는 원 요청/의향/결과는 향후 로컬 처분 이후에도 검증 가능하도록 준비 상태와 분리해 읽는다. 새 결과 최초 저장은 기존 준비 상태와 미전송 근거까지 요구한다.

이 단계는 결과 보존이며 로컬 처분·cursor 완료가 아니다. 준비/원 요청의 상태를 성공으로 바꾸지 않고 accepted_through_sequence를 전진시키지 않는다. 운영 migration은 적용하지 않는다.

격리 cancellationDatabaseFixture의 실제 DB에서 restoreBlockedProjections→collectSuppressedContent를 실행한 결과 blocked_projection_count=2, material_count=0, replacement_material_found=false였고 원문 spool에는 대체 본문이 존재했다. 이 관측은 기존 compactor를 그대로 취소에 연결하면 검출 재료가 누락될 수 있음을 보여준다. 다음 단계는 서명 의향/원 요청에 결합된 spool 본문을 검증해 처분 재료와 재유입 금지 식별자를 보존한 뒤, 실제 로컬 표면 검사/DB 교체 증거를 수집하는 것이다. 현재 취소 결과 저장을 로컬 처분 증거로 사용하지 않는다.
