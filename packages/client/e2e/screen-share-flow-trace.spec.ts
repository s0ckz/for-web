import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";

/** Execute the real trace helpers with browser timers, without accounts or capture permissions. */
const sources = Object.fromEntries(
  [
    "screenShareFlowTrace",
    "screenShareDiagnostics",
    "screenShareResolution",
  ].map((name) => [
    "./" + name + ".ts",
    ts.transpileModule(
      readFileSync(
        new URL(`../components/rtc/${name}.ts`, import.meta.url),
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      },
    ).outputText,
  ]),
);

test("frame-flow tracing uses legal browser timer receivers and stops without ending media", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(
    "<html><body>Local frame-flow timer fixture</body></html>",
  );
  const result = await page.evaluate(async (sources) => {
    const cache: Record<string, { exports: Record<string, unknown> }> = {};
    /** Load production helpers into the browser realm; no fake clock is injected. */
    function load(name: string): Record<string, unknown> {
      if (!cache[name]) {
        const module = { exports: {} };
        cache[name] = module;
        new Function("require", "exports", "module", sources[name])(
          load,
          module.exports,
          module,
        );
      }
      return cache[name].exports;
    }
    const start = load("./screenShareFlowTrace.ts")
      .startScreenShareFlowTrace as typeof import("../components/rtc/screenShareFlowTrace").startScreenShareFlowTrace;
    const events: Record<string, unknown>[] = [];
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const track = canvas.captureStream(1).getVideoTracks()[0];
    const peer = new RTCPeerConnection();
    const sender = peer.addTrack(track);
    const stop = start({
      getSender: () => sender,
      experiment: { codec: "h264", traceSeconds: 90 },
      log: (record) => events.push(record),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      stop();
      const count = events.length;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return {
        events,
        stableAfterStop: events.length === count,
        trackLive: track.readyState === "live",
      };
    } finally {
      stop();
      peer.close();
      track.stop();
    }
  }, sources);
  expect(errors).toEqual([]);
  expect(result.events[0].event).toBe("start");
  expect(
    result.events.filter((record) => record.event === "sample").length,
  ).toBeGreaterThanOrEqual(2);
  expect(result.events.at(-1)?.reason).toBe("stopped");
  expect(result.stableAfterStop).toBe(true);
  expect(result.trackLive).toBe(true);
});
