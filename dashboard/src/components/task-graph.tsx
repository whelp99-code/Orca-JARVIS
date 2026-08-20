import { useState } from "react";

type TaskGraphProps = Readonly<{
  sourceIds: readonly string[];
}>;

type GraphView = "graph" | "list";

export function TaskGraph({ sourceIds }: TaskGraphProps) {
  const [view, setView] = useState<GraphView>("graph");

  return (
    <section className="panel task-graph" aria-label="Task graph">
      <header className="panel-header graph-panel-header">
        <h2>Graph</h2>
        <div className="view-controls" role="group" aria-label="Task graph display">
          <button
            type="button"
            aria-label="Graph view"
            aria-pressed={view === "graph"}
            onClick={() => { setView("graph"); }}
          >
            Graph
          </button>
          <button
            type="button"
            aria-label="List view"
            aria-pressed={view === "list"}
            onClick={() => { setView("list"); }}
          >
            List
          </button>
        </div>
      </header>
      <div className="panel-body">
        {sourceIds.length === 0 ? (
          <p className="empty-state" role="status">No task sources</p>
        ) : view === "graph" ? (
          <div className="task-graph-visual" role="img" aria-label="Task source graph">
            {sourceIds.map((sourceId, index) => (
              <div className="task-graph-step" key={sourceId}>
                <span className="task-graph-edge">{index === 0 ? "Start" : "Edge"}</span>
                <span className="task-graph-node">{sourceId}</span>
              </div>
            ))}
          </div>
        ) : (
          <ol className="record-list task-source-list" aria-label="Task sources">
            {sourceIds.map((sourceId, index) => (
              <li className="record" key={sourceId}>
                <span className="task-graph-edge">{index === 0 ? "Start" : "Edge"}</span>
                <span className="record-title">{sourceId}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
