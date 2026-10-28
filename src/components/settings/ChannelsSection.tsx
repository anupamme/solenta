import { useCallback, useEffect, useState } from "react";
import { resolveCoderApi } from "../../coderApi";
import type {
  AppSettings,
  ChannelStatus,
  CoderApi,
  ProjectInfo,
} from "../../shared/ipc";
import styles from "../SettingsModal.module.css";

type ChannelApi = Pick<
  CoderApi["settings"],
  "channelStatus" | "connectChannel" | "disconnectChannel"
>;

export interface ChannelsSectionProps {
  active: boolean;
  settings: AppSettings | null;
  projects?: ProjectInfo[];
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  /** Test seam; defaults to window.coder.settings. */
  api?: ChannelApi;
}

function message(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/** "123, 456 789" → ["123", "456", "789"]. Main validates each id. */
function parseIds(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

function statusText(s: ChannelStatus["telegram"] | null): string {
  if (!s || s.state === "off") return "Not connected";
  if (s.state === "connecting") return "Connecting…";
  if (s.state === "error") return `Error: ${s.error ?? "unknown"}`;
  return s.botUsername ? `Connected as @${s.botUsername}` : "Connected";
}

/** Telegram chat channel (#1718): start and continue threads from a chat. */
export function ChannelsSection({
  active,
  settings,
  projects = [],
  onSaveSettings,
  api,
}: ChannelsSectionProps) {
  const tg = settings?.telegram;
  const [token, setToken] = useState("");
  const [ids, setIds] = useState("");
  const [projectId, setProjectId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [status, setStatus] = useState<ChannelStatus["telegram"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const channelApi = useCallback(
    (): ChannelApi => api ?? resolveCoderApi().settings,
    [api],
  );

  useEffect(() => {
    if (!active) return;
    setIds((tg?.allowedSenderIds ?? []).join(", "));
    setProjectId(tg?.projectId ?? "");
    setProfileId(tg?.agentProfileId ?? "");
    setToken("");
    setError(null);
    channelApi()
      .channelStatus()
      .then((s) => setStatus(s.telegram))
      .catch(() => setStatus(null));
    // Re-seed only when the pane opens, not on every settings echo.
  }, [active]);

  const save = async () => {
    await onSaveSettings({
      telegram: {
        enabled: tg?.enabled ?? false,
        allowedSenderIds: parseIds(ids),
        projectId: projectId || null,
        agentProfileId: profileId || null,
        // Omitted keeps the saved token: the renderer never sees it.
        ...(token.trim() ? { botToken: token.trim() } : {}),
      },
    });
    setToken("");
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.state === "connected" || status?.state === "connecting";

  return (
    <section className={styles.section} data-channels-telegram="">
      <h3 className={styles.sectionLabel}>Telegram</h3>
      <p className={styles.note}>
        Start and continue threads by messaging your own Telegram bot. Results,
        approvals and questions come back to the chat. Create a bot with
        @BotFather and paste its token here.
      </p>
      <div className={styles.memoryRow}>
        <span
          className={styles.memoryDot}
          data-on={status?.state === "connected" ? "true" : undefined}
          aria-hidden
        />
        <span data-telegram-status="">{statusText(status)}</span>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="telegram-bot-token">
          Bot token
        </label>
        <input
          id="telegram-bot-token"
          className={styles.input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={tg?.hasToken ? "Saved. Paste a new token to replace it" : "123456789:AA…"}
          value={token}
          disabled={busy}
          data-telegram-token=""
          onChange={(e) => setToken(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="telegram-allowed-ids">
          Allowed sender IDs
        </label>
        <input
          id="telegram-allowed-ids"
          className={styles.input}
          spellCheck={false}
          placeholder="123456789"
          value={ids}
          disabled={busy}
          data-telegram-allowed-ids=""
          onChange={(e) => setIds(e.target.value)}
        />
        <p className={styles.note}>
          Required. Numeric Telegram user IDs, comma separated. Messages from
          anyone else are ignored and get no reply. Their IDs show up in the
          Solenta log, so you can copy yours from there.
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="telegram-project">
          Default project
        </label>
        <select
          id="telegram-project"
          className={styles.input}
          value={projectId}
          disabled={busy}
          data-telegram-project=""
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">Choose a project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="telegram-profile">
          Agent profile
        </label>
        <select
          id="telegram-profile"
          className={styles.input}
          value={profileId}
          disabled={busy}
          data-telegram-profile=""
          onChange={(e) => setProfileId(e.target.value)}
        >
          <option value="">Project default</option>
          {(settings?.agentProfiles ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className={styles.note}>
          Chat threads use this profile's or the project's permission mode,
          never a more permissive one.
        </p>
      </div>

      <div className={styles.fieldRow}>
        <button
          type="button"
          className={styles.btn}
          disabled={busy}
          data-telegram-save=""
          onClick={() => void run(save)}
        >
          Save
        </button>
        {connected ? (
          <button
            type="button"
            className={styles.btn}
            disabled={busy}
            data-telegram-disconnect=""
            onClick={() =>
              void run(async () => {
                const s = await channelApi().disconnectChannel({ channel: "telegram" });
                setStatus(s.telegram);
              })
            }
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={busy}
            data-telegram-connect=""
            onClick={() =>
              void run(async () => {
                await save();
                try {
                  const s = await channelApi().connectChannel({ channel: "telegram" });
                  setStatus(s.telegram);
                } catch (err) {
                  setStatus({ state: "error", botUsername: null, error: message(err) });
                  throw err;
                }
              })
            }
          >
            Connect
          </button>
        )}
      </div>
      {error ? (
        <p className={styles.fieldError} role="alert" data-telegram-error="">
          {error}
        </p>
      ) : null}
    </section>
  );
}
