import { useState } from "react";
import type {
  AppSettings,
  PrivacyGatewaySettings,
  PrivacyLevel,
  ProviderInfo,
} from "../../shared/ipc";
import styles from "../SettingsModal.module.css";

const LEVELS: { value: PrivacyLevel; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "secrets", label: "Secrets" },
  { value: "strict", label: "Secrets and personal data" },
];

const EMPTY: PrivacyGatewaySettings = { default: "off", providers: {}, patterns: [] };

/** Privacy gateway (#295): per-provider redaction of outbound prompts. */
export function PrivacyGatewayEditor({
  settings,
  providers,
  onSaveSettings,
}: {
  settings: AppSettings | null;
  providers: ProviderInfo[];
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
}) {
  const pg = settings?.privacyGateway ?? EMPTY;
  const [patternsText, setPatternsText] = useState(() => pg.patterns.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (patch: Partial<PrivacyGatewaySettings>) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await onSaveSettings({ privacyGateway: { ...pg, ...patch } });
      setPatternsText((saved.privacyGateway ?? EMPTY).patterns.join("\n"));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const setProvider = (id: string, value: string) => {
    const next = { ...pg.providers };
    if (value) next[id] = value as PrivacyLevel;
    else delete next[id];
    void save({ providers: next });
  };

  const defaultLabel = LEVELS.find((l) => l.value === pg.default)?.label ?? "Off";

  return (
    <section className={styles.section} data-privacy-gateway="">
      <h3 className={styles.sectionLabel}>Privacy gateway</h3>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="privacy-default">
          Every provider
        </label>
        <select
          id="privacy-default"
          className={styles.input}
          data-privacy-default=""
          value={pg.default}
          disabled={saving || settings == null}
          onChange={(e) => void save({ default: e.target.value as PrivacyLevel })}
        >
          {LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      {providers.map((p) => (
        <div key={p.id} className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`privacy-${p.id}`}>
            {p.name}
          </label>
          <select
            id={`privacy-${p.id}`}
            className={styles.input}
            data-privacy-provider={p.id}
            value={pg.providers[p.id] ?? ""}
            disabled={saving || settings == null}
            onChange={(e) => setProvider(p.id, e.target.value)}
          >
            <option value="">Same as every provider ({defaultLabel})</option>
            {LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      ))}
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="privacy-patterns">
          Extra patterns (one regex per line, redacted with personal data)
        </label>
        <textarea
          id="privacy-patterns"
          className={styles.textarea}
          rows={3}
          spellCheck={false}
          placeholder={"ACME-\\d{6}\nproject-falcon"}
          value={patternsText}
          disabled={saving || settings == null}
          data-privacy-patterns=""
          onChange={(e) => {
            setPatternsText(e.target.value);
            setError(null);
          }}
          onBlur={() => {
            const patterns = patternsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            if (patterns.join("\n") === pg.patterns.join("\n")) return;
            void save({ patterns });
          }}
        />
        {error ? (
          <p className={styles.fieldError} role="alert">
            {error}
          </p>
        ) : null}
        <p className={styles.note}>
          Redacts matches from every prompt Solenta sends a provider, including
          hand-off context, memory notes, PDF text and steers, and notes each
          redaction in the thread. Secrets covers API keys, tokens, private
          keys and this thread's secret cards. Personal data adds emails, card
          numbers and US social security numbers. Files and command output the
          agent reads for itself go straight from its CLI to the provider and
          are not filtered.
        </p>
      </div>
    </section>
  );
}
