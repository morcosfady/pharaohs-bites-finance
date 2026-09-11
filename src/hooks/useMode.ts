import { useSettings } from "./queries";

/** Simple mode (default) hides the advanced tabs, fields and metrics.
 *  Toggled in Settings; stored in business_settings.advanced_mode. */
export function useAdvanced(): boolean {
  const s = useSettings();
  return s.data?.advanced_mode ?? false;
}
