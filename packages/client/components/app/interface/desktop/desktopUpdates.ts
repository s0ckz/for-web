export interface DesktopUpdateState {
  status: "idle" | "downloading" | "ready" | "installing";
  version: string | null;
}

export interface DesktopUpdater {
  getState(): Promise<DesktopUpdateState>;
  onState(handler: (state: DesktopUpdateState) => void): () => void;
  install(): Promise<boolean>;
}

/** Local IPC only. Subscribe before taking the snapshot so downloads cannot be missed. */
export function observeDesktopUpdates(
  bridge: DesktopUpdater | undefined,
  receive: (state: DesktopUpdateState) => void,
): () => void {
  if (!bridge) return () => {};
  let stopped = false;
  let receivedEvent = false;
  const unsubscribe = bridge.onState((state) => {
    receivedEvent = true;
    if (!stopped) receive(state);
  });
  void bridge
    .getState()
    .then((state) => {
      // An event can overtake the IPC reply. Never replace newer pushed state
      // with an old snapshot, or update an unmounted titlebar.
      if (!stopped && !receivedEvent) receive(state);
    })
    .catch(() => {});
  return () => {
    stopped = true;
    unsubscribe();
  };
}
