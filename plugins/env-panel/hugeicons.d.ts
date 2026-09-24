// @hugeicons/core-free-icons 4.3.3 ships per-icon modules without types.
declare module "@hugeicons/core-free-icons/*" {
  import type { IconSvgElement } from "@hugeicons/react";
  const icon: IconSvgElement;
  export default icon;
}
