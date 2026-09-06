import type { JSX } from "solid-js";

import "mdui/components/checkbox.js";

type Props = {
  children?: JSX.Element;
  required?: boolean;
  name?: string;
  checked?: boolean;
  disabled?: boolean;
  indeterminate?: boolean;
  class?: string;
  onChange?: (event: { currentTarget: { checked: boolean } }) => void;
  /**
   * Associates this checkbox with an element describing it (e.g. a warning
   * rendered above it) for screen readers.
   *
   * The spread below puts the attribute on the `<mdui-checkbox>` custom
   * element itself. Whether assistive tech then associates it with the
   * native input mdui renders inside its shadow root is **unverified** --
   * mdui@2.1.3's checkbox source never mentions `aria-describedby`, so it
   * is not explicitly forwarded. Worth confirming with an actual screen
   * reader before relying on it; it costs nothing if it turns out inert.
   */
  "aria-describedby"?: string;
};

/**
 * Checkboxes let users select one or more items from a list, or turn an item on or off
 *
 * @library MDUI
 * @specification https://m3.material.io/components/checkbox
 */
export function Checkbox(props: Props) {
  return <mdui-checkbox {...props} />;
}
