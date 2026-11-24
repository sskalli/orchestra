import "./workspace-orbit-spinner.css";

export function OrbitSpinner() {
  return (
    <svg className="workspace-orbit-spinner" width="14" height="14" viewBox="0 0 14 14"
      aria-hidden="true" focusable="false">
      <circle className="workspace-orbit-dot" cx="7" cy="2.5" r="1.5" fill="currentColor" />
    </svg>
  );
}
