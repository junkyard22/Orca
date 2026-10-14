/**
 * Deliver a one-shot message to the renderer only once the page can receive it.
 *
 * `ready-to-show` fires on the window's first paint, which can come before the
 * renderer's scripts have run and registered their IPC listeners (app.js is
 * loaded at the end of the document). A message sent in that gap is dropped by
 * Electron without error, and the window then shows "starting…" until something
 * else re-sends it (saving Settings re-runs init). Seen in the packaged 1.7.0
 * candidate when several instances started at once; the Summit line fixed the
 * same race for its demo mode (d54b5da). Waiting for `did-finish-load` when the
 * page is still loading closes the gap; a page that has finished loading has
 * run its scripts, so the message can go at once.
 */
export interface LoadAwareContents {
  isDestroyed(): boolean;
  isLoading(): boolean;
  once(event: "did-finish-load", listener: () => void): unknown;
  send(channel: string, ...args: unknown[]): void;
}

export function sendWhenLoaded(contents: LoadAwareContents | null | undefined, channel: string, payload: unknown): "sent" | "deferred" | "dropped" {
  if (!contents || contents.isDestroyed()) return "dropped";
  if (contents.isLoading()) {
    contents.once("did-finish-load", () => {
      if (!contents.isDestroyed()) contents.send(channel, payload);
    });
    return "deferred";
  }
  contents.send(channel, payload);
  return "sent";
}
