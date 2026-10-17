/**
 * Stands in for `@amazon-devices/kepler-performance-api` on Fire OS. Vega's
 * fully-drawn marker is how its KPI tool measures launch to fully drawn
 * (apps/tv-vega/src/App.tsx); Fire OS has no such tool to tell, so the
 * marker is a callback that does nothing.
 */
const nothing = (): void => undefined;

export function useReportFullyDrawn(): () => void {
  return nothing;
}
