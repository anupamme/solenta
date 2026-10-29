import { useId } from "react";
import type { AutoApprove } from "../shared/ipc";
import {
  AUTO_APPROVE_PRESETS,
  AUTO_APPROVE_TOGGLES,
  normalizeAutoApprove,
  sameAutoApprove,
} from "../autoApprove";
import styles from "./AutoApproveMatrix.module.css";

/**
 * Auto-approve toggles (#1721): the composer's permission menu and the
 * agent-profile form. A child toggle stays disabled until its parent is on;
 * turning a parent off turns its children off.
 */
export function AutoApproveMatrix({
  value,
  onChange,
  disabled = false,
  note,
}: {
  value: AutoApprove;
  onChange: (next: AutoApprove) => void;
  disabled?: boolean;
  /** Enforcement caveat, e.g. the "best effort" line for non-Claude CLIs. */
  note?: string | null;
}) {
  const id = useId();
  const set = (patch: Partial<AutoApprove>) =>
    onChange(normalizeAutoApprove({ ...value, ...patch }));
  return (
    <fieldset className={styles.matrix} data-auto-approve="" disabled={disabled}>
      <legend className={styles.legend}>Auto-approve</legend>
      <div className={styles.presets} role="group" aria-label="Auto-approve presets">
        {AUTO_APPROVE_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className={styles.preset}
            aria-pressed={sameAutoApprove(value, { ...p.value, notify: value.notify })}
            data-auto-approve-preset={p.name}
            onClick={() => set({ ...p.value, notify: value.notify })}
          >
            {p.name}
          </button>
        ))}
      </div>
      {AUTO_APPROVE_TOGGLES.map((t) => {
        const locked = t.parent ? !value[t.parent] : false;
        return (
          <label
            key={t.id}
            className={styles.toggle}
            data-child={t.parent ? "true" : undefined}
            data-locked={locked ? "true" : undefined}
            htmlFor={`${id}-${t.id}`}
          >
            <input
              id={`${id}-${t.id}`}
              type="checkbox"
              data-auto-approve-toggle={t.id}
              checked={value[t.id]}
              disabled={locked}
              title={
                locked
                  ? `Turn on ${AUTO_APPROVE_TOGGLES.find((p) => p.id === t.parent)?.label} first`
                  : undefined
              }
              onChange={(e) => set({ [t.id]: e.target.checked })}
            />
            {t.label}
          </label>
        );
      })}
      {note && (
        <p className={styles.note} data-auto-approve-note="">
          {note}
        </p>
      )}
    </fieldset>
  );
}
