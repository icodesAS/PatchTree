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
    borderRadius: 8,
  });

  const state = (data?.state as string) || 'idle';

  return (
    <g className={`pt-edge pt-edge--${state}`}>
      <BaseEdge id={id} path={path} />
    </g>
  );
}
