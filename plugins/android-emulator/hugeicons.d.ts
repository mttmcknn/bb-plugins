// @hugeicons/core-free-icons 4.3.3 ships per-icon ESM files without per-icon
// declarations; the vendored components import them by subpath.
declare module "@hugeicons/core-free-icons/*" {
  const icon: import("@hugeicons/react").IconSvgElement;
  export default icon;
}
