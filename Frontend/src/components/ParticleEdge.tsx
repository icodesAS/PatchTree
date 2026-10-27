import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

export default function ParticleEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 16,
  });

  const state = (data?.state as string) || 'idle';
  const live = state === 'running' || state === 'winner';

  return (
    <g className={`react-flow__edge is-${state}`}>
      <BaseEdge id={id} path={path} />
      {live &&
        [0, 0.45, 0.9].map((delay) => (
          <circle key={delay} r="2.6" className="pt-particle">
            <animateMotion dur="1.4s" begin={`${delay}s`} repeatCount="indefinite" path={path} />
          </circle>
        ))}
    </g>
  );
}
