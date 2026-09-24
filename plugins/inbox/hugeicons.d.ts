// hugeicons 4.3.3 ships per-icon modules without declarations.
declare module "@hugeicons/core-free-icons/*" {
  import type { IconSvgElement } from "@hugeicons/react";
  const icon: IconSvgElement;
  export default icon;
}
