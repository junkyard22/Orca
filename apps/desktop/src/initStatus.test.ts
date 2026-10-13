import { describe, expect, it } from "vitest";
import { sendWhenLoaded } from "./initStatus";

function fakeContents(loading: boolean, destroyed = false) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  let onLoad: (() => void) | null = null;
  return {
    sent,
    finishLoad() { onLoad?.(); onLoad = null; },
    destroy() { destroyed = true; },
    contents: {
      isDestroyed: () => destroyed,
      isLoading: () => loading,
      once: (_e: "did-finish-load", l: () => void) => { onLoad = l; },
      send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); },
    },
  };
}

describe("init-status delivery", () => {
  it("sends at once when the page has finished loading (its listeners exist)", () => {
    const f = fakeContents(false);
    expect(sendWhenLoaded(f.contents, "init-status", { ok: true })).toBe("sent");
    expect(f.sent).toEqual([{ channel: "init-status", payload: { ok: true } }]);
  });

  it("holds the message until did-finish-load when the page is still loading — the ready-to-show race", () => {
    const f = fakeContents(true);
    expect(sendWhenLoaded(f.contents, "init-status", { ok: true })).toBe("deferred");
    expect(f.sent).toEqual([]);           // nothing dropped into the gap
    f.finishLoad();
    expect(f.sent).toEqual([{ channel: "init-status", payload: { ok: true } }]);
  });

  it("drops nothing on a destroyed window, and does not send to a window destroyed while waiting", () => {
    expect(sendWhenLoaded(null, "init-status", {})).toBe("dropped");
    const gone = fakeContents(false, true);
    expect(sendWhenLoaded(gone.contents, "init-status", {})).toBe("dropped");
    expect(gone.sent).toEqual([]);
    const closing = fakeContents(true);
    sendWhenLoaded(closing.contents, "init-status", {});
    closing.destroy();
    closing.finishLoad();
    expect(closing.sent).toEqual([]);
  });
});
