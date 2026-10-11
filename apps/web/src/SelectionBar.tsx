import { useI18n } from "./i18n";

import "./schedule-flow.css";

export function SelectionBar(props: {
  count: number;
  hint?: string;
  actionLabel: string;
  onAction(): void;
  visible: boolean;
}) {
  const { t } = useI18n();

  return (
    <div
      className={`schedule-selection-bar${props.visible ? " schedule-selection-bar--visible" : ""}`}
      aria-hidden={!props.visible}
    >
      <div className="schedule-selection-bar__copy">
        <span>{t.schedule.selectedCount(props.count)}</span>
        {props.hint ? <small>{props.hint}</small> : null}
      </div>
      <button
        type="button"
        className="schedule-primary-button"
        disabled={props.count === 0}
        tabIndex={props.visible ? undefined : -1}
        onClick={props.onAction}
      >
        {props.actionLabel}
      </button>
    </div>
  );
}
