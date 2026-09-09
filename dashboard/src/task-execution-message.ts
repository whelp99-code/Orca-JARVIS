import { DashboardApiError } from "./api.js";

const messages: Record<string, string> = {
  TASK_WORK_LINEAGE_INVALID: "업무 관계와 이전 요청 ID·다이제스트를 확인하세요.",
  TASK_WORK_LINEAGE_BINDING_INVALID: "이전 요청을 연결할 수 없습니다. 같은 저장소의 앞선 요청인지, 조회 가능한 요청인지 확인하세요.",
  TASK_TEMPLATE_INVALID: "템플릿 입력을 확인하세요. 파일 경로는 중복 없이, 보고서 결과 파일은 하나만 지정하세요.",
  TASK_TEMPLATE_PLAN_MISMATCH: "승인된 템플릿의 파일 범위와 필수 검사를 유지해야 합니다. 범위 변경은 새 업무 승인이 필요합니다.",
  TASK_SPEC_BINDING_INVALID: "업무 명세와 템플릿 요구사항이 일치하지 않습니다. 제안을 다시 확인하세요.",
  TASK_REPOSITORY_FILE_CHANGED: "선택한 작업 파일이 기준 커밋과 다릅니다. 변경을 커밋한 뒤 계획을 다시 준비하세요.",
  TASK_REPOSITORY_BASELINE_CHANGED: "파일 또는 기준 커밋이 바뀌었습니다. 파일 선택을 확인하고 계획을 다시 준비하세요.",
  TASK_EXECUTION_PREVIEW_STALE: "검토 후 저장소가 바뀌었습니다. 최신 기준으로 계획을 다시 준비하세요.",
  TASK_REPOSITORY_FILE_INVALID: "선택한 파일을 읽을 수 없습니다. 일반 파일인지, 경로와 소유자가 맞는지 확인하세요.",
  TASK_PUBLICATION_GIT_IDENTITY_INVALID: "저장소 최상위 경로와 접근 권한을 확인하세요.",
  TASK_PUBLICATION_GIT_IDENTITY_CHANGED: "저장소가 교체되었습니다. 경로를 확인하고 계획을 다시 준비하세요.",
  TASK_PUBLICATION_REF_EXISTS: "결과 브랜치가 이미 있습니다. 새 브랜치 이름을 지정하세요.",
  TASK_EXECUTION_PLAN_INVALID: "파일·검사·시간 제한을 확인하세요. 수정 파일과 검사가 각각 하나 이상 필요합니다.",
  TASK_EXECUTION_INPUT_INVALID: "계획 입력을 확인하세요.",
  TASK_EXECUTION_PLAN_TOO_LARGE: "계획이 너무 큽니다. 작업을 나누거나 파일·검사 범위를 줄이세요.",
  TASK_REPOSITORY_INPUT_OVERSIZE: "선택 파일은 각각 4 MiB, 합계 16 MiB 이하여야 합니다.",
  TASK_PUBLICATION_GIT_OUTPUT_LIMIT: "선택 파일 또는 Git 조회 결과가 크기 한도를 넘었습니다.",
  TASK_EXECUTION_START_APPROVAL_REQUIRED: "먼저 이 작업의 시작 요청을 승인하고 실행하세요.",
  TASK_EXECUTION_BINDING_INVALID: "이 실행 계획을 현재 작업 명세에 연결할 수 없습니다. 작업 제안을 확인하세요.",
  TASK_EXECUTION_BUDGET_EXHAUSTED: "작업 기한 또는 실행 횟수 한도가 소진됐습니다. 새 작업 계획이 필요합니다.",
  TASK_EXECUTION_WORKFLOW_NOT_READY: "현재 작업 상태에서는 새 실행 계획을 준비할 수 없습니다.",
  TASK_COMPLETION_WORKFLOW_NOT_READY: "현재 작업 상태 또는 기한으로 실행할 수 없습니다.",
  TASK_COMPLETION_WORKFLOW_UNSUPPORTED: "이 작업 흐름은 검증 결과 자동 완료를 지원하지 않습니다.",
  TASK_EXECUTION_NOT_CONFIGURED: "실행 환경이 설정되지 않았습니다. 자비스 운영 설정을 확인하세요.",
  TASK_PROVIDER_UNSUPPORTED: "선택한 실행 에이전트는 아직 지원되지 않습니다.",
  TASK_PROVIDER_UNAVAILABLE: "실행 에이전트를 사용할 수 없습니다. 운영 설정을 확인하세요.",
  TASK_VERIFIER_UNAVAILABLE: "독립 검증기를 사용할 수 없습니다. 운영 설정을 확인하세요.",
  TASK_SANDBOX_UNAVAILABLE: "격리 실행 환경을 사용할 수 없습니다. 운영 설정을 확인하세요.",
};
export function taskExecutionMessage(error: unknown): string {
  if (error instanceof DashboardApiError) return messages[error.code] ?? "요청 결과를 확인하지 못했습니다. 상태를 다시 조회하세요.";
  return "연결을 확인하고 상태를 다시 조회하세요.";
}
export function taskReadinessMessage(code: string): string {
  const readinessMessages: Record<string, string> = {
    TASK_VERIFIER_DATABASE_UNAVAILABLE: "검증기가 작업 기록 저장소에 접근할 수 없습니다. 자비스의 저장소 경로와 접근 권한을 확인하세요.",
    TASK_EXECUTION_CLOCK_UNAVAILABLE: "실행 시간 제한을 확인할 수 없습니다. 자비스 호스트의 시간 검사 환경을 확인하세요.",
    TASK_EXECUTION_PREFLIGHT_FAILED: "실행 준비 검사에 실패했습니다. 자비스 운영 진단을 확인한 뒤 환경 검사를 다시 실행하세요.",
    TASK_CERTIFICATION_BINDING_INVALID: "독립 검증 권한을 확인할 수 없습니다. 검증 키의 등록·용도·철회 상태를 확인하세요.",
  };
  return readinessMessages[code] ?? messages[code] ?? "실행 준비 상태를 확인하지 못했습니다. 운영 진단을 확인하세요.";
}
export function isTaskExecutionRejection(error: unknown): boolean {
  return error instanceof DashboardApiError && (error.kind === "forbidden" || Object.hasOwn(messages, error.code));
}
