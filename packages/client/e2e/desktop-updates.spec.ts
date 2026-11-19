import { type Page, expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function setup(
  page: Page,
  bridge: boolean | "browser",
  ready = false,
  customFrame = true,
) {
  // Public API configuration only; all external requests are intercepted.
  // No account, real updater, remote API or release-feed requests are used.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (["localhost", "127.0.0.1"].includes(url.hostname))
      return route.continue();
    if (url.pathname === "/" || url.pathname === "/api")
      return route.fulfill({
        json: {
          revolt: "0.15.1",
          ws: "wss://example.invalid/ws",
          app: "https://example.invalid",
          vapid: "",
          features: {
            captcha: { enabled: false, key: "" },
            email: false,
            invite_only: false,
            autumn: { enabled: false, url: "https://example.invalid/autumn" },
            january: { enabled: false, url: "https://example.invalid/january" },
            livekit: { enabled: false, nodes: [] },
            limits: { global: {}, new_user: {}, default: {} },
            legal_links: {
              terms_of_service: "",
              privacy_policy: "",
              guidelines: "",
            },
          },
        },
      });
    return route.abort();
  });
  await page.addInitScript(
    ({ bridge, ready, customFrame }) => {
      const listeners = new Set<
        (state: { status: string; version: string | null }) => void
      >();
      let state = {
        status: ready ? "ready" : "idle",
        version: ready ? "1.9.0" : null,
      };
      const fixture = {
        listeners,
        installs: 0,
        emit(status: string) {
          state = { status, version: status === "ready" ? "1.9.0" : null };
          for (const listener of listeners) listener(state);
        },
      };
      Object.assign(window, { updateFixture: fixture });
      if (bridge === "browser") return;
      window.desktopConfig = {
        get: () =>
          ({ customFrame, windowState: { isMaximised: false } }) as ReturnType<
            Window["desktopConfig"]["get"]
          >,
        set() {},
        getAutostart: async () => false,
        setAutostart: async (value) => value,
      };
      window.native = {
        versions: {
          desktop: () => "1.8.2",
          node: () => "22",
          electron: () => "43",
          chrome: () => "150",
        },
        minimise() {},
        maximise() {},
        close() {},
        onceScreenPicker() {},
        screenPickerCallback() {},
        ...(bridge
          ? {
              updater: {
                getState: async () => state,
                onState: (
                  listener: (state: {
                    status: string;
                    version: string | null;
                  }) => void,
                ) => {
                  listeners.add(listener);
                  return () => listeners.delete(listener);
                },
                install: async () => {
                  fixture.installs++;
                  fixture.emit("installing");
                  return true;
                },
              },
            }
          : {}),
      } as Window["native"];
    },
    { bridge, ready, customFrame },
  );
  await page.goto("/login/auth");
  await expect(page.locator("input").first()).toBeVisible();
}

test("desktop update status is prominent, pushed locally and keyboard operable", async ({
  page,
}, testInfo) => {
  await setup(page, true);
  const button = page.locator("[data-desktop-update]");
  await expect(button).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { updateFixture: { emit(status: string): void } }
    ).updateFixture.emit("downloading"),
  );
  await expect(button).toHaveAccessibleName("Downloading update…");
  await expect(button).toBeDisabled();
  await page.evaluate(() =>
    (
      window as unknown as { updateFixture: { emit(status: string): void } }
    ).updateFixture.emit("ready"),
  );
  await expect(button).toHaveAccessibleName("Restart to update");
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page
    .locator("[data-desktop-titlebar]")
    .screenshot({ path: testInfo.outputPath("update-titlebar.png") });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveAccessibleName("Restarting…");
  await expect(button).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { updateFixture: { installs: number } })
          .updateFixture.installs,
    ),
  ).toBe(1);
});

test("a staged update survives reload and remains reachable with native window chrome at 300px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 300, height: 720 });
  await setup(page, true, true, false);
  const button = page.getByRole("button", {
    name: "Restart to update",
    exact: true,
  });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(300);
  await page.reload();
  await expect(button).toBeVisible();
});

for (const bridge of [false, "browser"] as const) {
  test(`older desktop / browser compatibility: ${bridge}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(page, bridge);
    await expect(page.locator("[data-desktop-update]")).toHaveCount(0);
    expect(
      errors.filter((message) => !message.includes("ResizeObserver")),
    ).toEqual([]);
  });
}

test.describe("Portuguese update indicator", () => {
  test.use({ locale: "pt-BR", colorScheme: "dark" });
  test("shows the restart action in Brazilian Portuguese", async ({
    page,
  }, testInfo) => {
    await setup(page, true, true);
    await expect(page.locator("[data-desktop-update]")).toHaveAccessibleName(
      "Reiniciar para atualizar",
    );
    await page
      .locator("[data-desktop-titlebar]")
      .screenshot({ path: testInfo.outputPath("update-titlebar-pt-BR.png") });
  });
});
