import type { BudgetDraft } from "../budget";
import { BUDGET_FIELDS } from "../budget";
import styles from "./BudgetFields.module.css";

/**
 * Hard budget cap inputs (#286): one per axis, blank = no limit. Shared by
 * the thread budget card, the agent profile editor and the automation form.
 * Strings, not numbers, so a half-typed "0." survives.
 */
export function BudgetFields({
  draft,
  onChange,
  disabled,
}: {
  draft: BudgetDraft;
  onChange: (next: BudgetDraft) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.fields} data-budget-fields="">
      {BUDGET_FIELDS.map(({ key, label, hint }) => (
        <label key={key} className={styles.field} title={hint}>
          <span className={styles.label}>{label}</span>
          <input
            className={styles.input}
            type="text"
            inputMode="decimal"
            placeholder="No limit"
            aria-label={`${label} cap`}
            data-budget-field={key}
            value={draft[key]}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, [key]: e.target.value })}
          />
        </label>
      ))}
    </div>
  );
}
