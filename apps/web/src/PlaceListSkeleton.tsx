/**
 * Placeholder rows shaped like the real place list while it loads. The visible rows are
 * decorative; the status text stays available to screen readers.
 */
export function PlaceListSkeleton({ label, className, rows = 4 }: { label: string; className?: string; rows?: number }) {
  return (
    <div className={className}>
      <p className="sr-only" role="status">{label}</p>
      <div className="pd-list place-list-skeleton" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="list-place-row">
            <span className="place-list-skeleton__block place-list-skeleton__thumb" />
            <span className="place-list-skeleton__lines">
              <span className="place-list-skeleton__block place-list-skeleton__title" />
              <span className="place-list-skeleton__block place-list-skeleton__meta" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
