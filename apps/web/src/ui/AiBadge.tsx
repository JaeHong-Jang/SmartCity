import type { BuildingType } from '@smartcity/shared';

/** Small "AI" tag for designs the assistant made. */
export function AiBadge({ type }: { type: Pick<BuildingType, 'origin'> | undefined }) {
  if (type?.origin !== 'ai') return null;
  return (
    <span className="ai-badge" data-ai-badge title="AI가 만든 설계">
      AI
    </span>
  );
}
