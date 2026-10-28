/**
 * Settings → Integrations → Telegram (#1718).
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/channelsSection.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { createFakeCoder } from "./support/fakeCoder.ts";
import { ChannelsSection } from "../src/components/settings/ChannelsSection";
import type { AppSettings, ProjectInfo } from "../src/shared/ipc";

const projects = [
  { id: "p1", name: "app" },
  { id: "p2", name: "site" },
] as ProjectInfo[];

async function setup(fakeOpts: Parameters<typeof createFakeCoder>[0] = {}) {
  const fake = createFakeCoder(fakeOpts);
  let settings = (await fake.api.settings.get()) as AppSettings;
  const onSaveSettings = async (patch: Partial<AppSettings>) => {
    settings = await fake.api.settings.set(patch);
    return settings;
  };
  const view = await mount(
    <ChannelsSection
      active
      settings={settings}
      projects={projects}
      onSaveSettings={onSaveSettings}
      api={fake.api.settings}
    />,
  );
  await view.flush();
  return { fake, view, saved: () => settings };
}

describe("ChannelsSection", () => {
  afterEach(() => unmountAll());

  it("saves token, allowlist, project; connect shows the bot; token never read back", async () => {
    const { fake, view, saved } = await setup();
    assert.match(view.text(), /Not connected/);
    await view.type(view.query("[data-telegram-token]"), "123:abc");
    await view.type(view.query("[data-telegram-allowed-ids]"), "111, 222");
    await view.change(view.query("[data-telegram-project]"), "p2");
    await view.click(view.query("[data-telegram-connect]"));
    await view.flush();

    const [set] = fake.of("settings.set");
    assert.deepEqual(set.args[0], {
      telegram: {
        enabled: false,
        allowedSenderIds: ["111", "222"],
        projectId: "p2",
        agentProfileId: null,
        botToken: "123:abc",
      },
    });
    assert.equal(saved().telegram?.hasToken, true);
    assert.equal(saved().telegram?.botToken, undefined);
    assert.deepEqual(fake.only("settings.connectChannel").args, [{ channel: "telegram" }]);
    assert.match(view.query("[data-telegram-status]")!.textContent!, /Connected as @solenta_test_bot/);
    assert.equal((view.query("[data-telegram-token]") as HTMLInputElement).value, "");

    await view.click(view.query("[data-telegram-disconnect]"));
    await view.flush();
    assert.equal(fake.of("settings.disconnectChannel").length, 1);
    assert.match(view.text(), /Not connected/);
  });

  it("a blank token field keeps the saved token", async () => {
    const { fake, view } = await setup();
    await view.type(view.query("[data-telegram-allowed-ids]"), "111");
    await view.click(view.query("[data-telegram-save]"));
    await view.flush();
    const patch = fake.only("settings.set").args[0] as { telegram: Record<string, unknown> };
    assert.equal("botToken" in patch.telegram, false);
  });

  it("shows a connect failure", async () => {
    const { view } = await setup({ connectChannelError: "Unauthorized" });
    await view.click(view.query("[data-telegram-connect]"));
    await view.flush();
    assert.match(view.query("[data-telegram-error]")!.textContent!, /Unauthorized/);
    assert.match(view.query("[data-telegram-status]")!.textContent!, /Error: Unauthorized/);
  });
});
