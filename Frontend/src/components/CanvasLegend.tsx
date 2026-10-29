// Floating legend. Render it INSIDE <ReactFlow> ... </ReactFlow> (or any parent with position: relative).
// Pass your existing BRANCH_COLORS and BRANCH_LABELS so this file has no import paths to guess.

interface CanvasLegendProps {
  colors: Record<string, string>
  labels: Record<string, string>
}

export default function CanvasLegend({ colors, labels }: CanvasLegendProps) {
  return (
    <aside className="canvas-legend" aria-label="Node colour legend">
      {Object.entries(labels).map(([type, label]) => (
        <div key={type} className="canvas-legend__item">
          <span
            className="canvas-legend__dot"
            style={{ background: colors[type], color: colors[type] }}
          />
          {label}
        </div>
      ))}
      <div className="canvas-legend__item canvas-legend__item--live">
        <span className="canvas-legend__packet" />
        Live packet
      </div>
    </aside>
  )
}

// In App.tsx:
//   <ReactFlow ...>
//     <Controls />
//     <MiniMap />
//     {patchNodes.length > 0 && <CanvasLegend colors={BRANCH_COLORS} labels={BRANCH_LABELS} />}
//   </ReactFlow>
