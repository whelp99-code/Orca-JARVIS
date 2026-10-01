export const copy = {
  title: "JARVIS 현황판",
  skip: "본문으로 건너뛰기",
  navLabel: "주요 메뉴",
  nav: {
    today: "오늘",
    memory: "기억",
    overview: "한눈에",
    tasks: "작업",
    proposals: "새 제안",
    agents: "에이전트",
    approvals: "승인",
    security: "보안",
  },
  liveUpdates: "실시간",
  connected: "연결됨",
  disconnected: "끊김",
  readOnly: "읽기 전용",
  retry: "다시 시도",
  today: {
    unavailable: "오늘 화면을 열 수 없습니다. 서버가 오늘 자료를 아직 제공하지 않습니다.",
    loading: "오늘을 불러오는 중",
    error: "오늘 화면을 열 수 없습니다",
    kicker: "오늘 할 일",
    phone: "휴대폰에서는 읽기만 됩니다. 승인과 실행은 컴퓨터의 제어 화면에서 합니다.",
    stale: "저장된 화면이라 지금 결정할 수 없습니다. 연결이 돌아오면 다시 열립니다.",
    sections: {
      now: "지금",
      blocked: "막힌 일",
      decisions: "결정할 일",
      next: "다음 세 가지",
      workers: "에이전트",
      risks: "위험",
    },
    fields: {
      run: "오늘 실행",
      brief: "보고서",
      generated: "만든 시각",
      freshUntil: "이 시각까지 유효",
      notifications: "알림",
      closeout: "마감 확인",
    },
    empty: {
      run: "진행 중인 실행 없음",
      notReported: "아직 없음",
      closeout: "확인된 마감 없음",
      conflicts: "충돌",
      noConflicts: "충돌 없음",
      omissions: "빠진 자료",
      noOmissions: "빠진 자료 없음",
      decisions: "결정할 일 없음",
      next: "추천할 다음 일 없음",
      workers: "휴대폰에는 에이전트 상태를 보내지 않습니다.",
      risks: "열린 위험과 전달 못 한 알림 없음",
    },
  },
  pages: {
    today: "오늘",
    memory: "기억",
    tasks: "작업",
    task: "작업",
    agents: "에이전트",
    approvals: "승인",
    proposal: "새 제안",
    notFound: "없는 화면",
    notFoundMessage: "이 주소의 화면은 없습니다.",
  },
  cards: {
    work: "지금 하는 일",
    agents: "에이전트",
    approvals: "승인 대기",
    risks: "위험",
  },
  cardEmpty: {
    work: "진행 중인 일 없음",
    agents: "연결된 에이전트 없음",
    approvals: "대기 중인 승인 없음",
    risks: "열린 위험 없음",
  },
  recent: "최근 일",
  noRecent: "최근 기록이 없습니다",
  noApprovals: "대기 중인 승인이 없습니다",
  noRisks: "열린 위험이 없습니다",
  noAgents: "연결된 에이전트가 없습니다",
  portfolio: {
    kicker: "맥북과 JM 서버",
    title: "두 컴퓨터 현황",
    lead: "지금 각 컴퓨터가 얼마나 바쁜지, 깃허브에 뭐가 열려 있는지를 보여줍니다.",
    host: {
      local: "맥북",
      "jm-server": "JM 서버",
    },
    freshness: {
      live: "방금 갱신",
      stale: "조금 오래됨",
      unseen: "아직 없음",
      offline: "끊김",
    },
    updated: "갱신",
    lastUpdated: "마지막 갱신",
    refresh: "지금 갱신",
    refreshing: "불러오는 중",
    metrics: [
      ["작업 폴더", "worktree_count"],
      ["터미널", "terminal_count"],
      ["깨끗한 폴더", "clean_count"],
      ["손본 폴더", "dirty_count"],
      ["고친 파일", "dirty_path_count"],
      ["진행 작업", "active_task_count"],
    ] as const,
    github: "깃허브에서 열린 일",
    issues: "이슈",
    pulls: "풀 리퀘스트",
    milestones: "개발 일정",
    blockers: "지금 막힌 일",
    collector: "수집기",
    noReport: "아직 받은 기록이 없습니다",
    unavailable: "숫자를 아직 모으지 못했습니다",
    milestoneState: {
      done: "완료",
      in_progress: "진행 중",
    },
  },
} as const;

export function hostLabel(environment: string, fallback: string): string {
  if (environment === "local") {
    return copy.portfolio.host.local;
  }
  if (environment === "jm-server") {
    return copy.portfolio.host["jm-server"];
  }
  return fallback;
}

export function freshnessLabel(value: string): string {
  if (value === "live") {
    return copy.portfolio.freshness.live;
  }
  if (value === "stale") {
    return copy.portfolio.freshness.stale;
  }
  if (value === "unseen") {
    return copy.portfolio.freshness.unseen;
  }
  return copy.portfolio.freshness.offline;
}

export function milestoneStateLabel(state: string): string {
  return state === "done" ? copy.portfolio.milestoneState.done : copy.portfolio.milestoneState.in_progress;
}

const STATE_LABELS: Readonly<Record<string, string>> = {
  ready: "준비됨",
  stale: "오래됨",
  fresh: "최신",
  unseen: "아직 없음",
  offline: "끊김",
  pending: "대기",
  approved: "승인됨",
  failed: "실패",
  completed: "완료",
  command: "명령",
  workflow: "작업 흐름",
  live: "연결됨",
  high: "높음",
  medium: "중간",
  low: "낮음",
  critical: "심각",
  loading: "불러오는 중",
  error: "오류",
  unavailable: "사용할 수 없음",
  no_data: "자료 없음",
  degraded: "일부만 됨",
};

const ACTION_LABELS: Readonly<Record<string, string>> = {
  "memory.confirm": "기억 확인",
  "memory.outbox.dispatch": "기억 보내기",
  "memory.outbox.abandon-not-delivered": "전달 못 한 기억 닫기",
  "workflow.register": "작업 흐름 등록",
  "workflow.start": "작업 시작",
  "task.execute": "작업 실행",
};

export function stateLabel(value: string): string {
  return STATE_LABELS[value] ?? value;
}

export function actionLabel(value: string): string {
  return ACTION_LABELS[value] ?? value;
}

/** Display clock is fixed KST. Unparseable values stay as received. */
export function formatKst(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
