export { FloatingManager } from "./FloatingManager";
export { usePortalMount } from "./portalMount";
export { Tooltip } from "./Tooltip";
export { UserCard } from "./UserCard";

/**
 * Trigger a global pointerdown running the floating close logic
 */
export function dismissFloatingElements() {
  document.dispatchEvent(new Event("pointerdown"));
}
