import { useStore } from './context';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`panel toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
