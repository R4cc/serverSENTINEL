import { useCallback, useMemo } from "react";
import type { DisplayTimeZonePreference, RegionalFormatPreference } from "../types";
import { detectedBrowserTimeZone, resolveDisplayTimeZone, resolveRegionalFormatLocale } from "../utils/format";

/**
 * Resolves the locale and time zone the panel formats values in, and derives the
 * `Intl` formatters plus the `format*` helpers passed down to feature pages.
 */
export function useDisplayFormatters(inputs: {
  regionalFormatPreference: RegionalFormatPreference;
  displayTimeZonePreference: DisplayTimeZonePreference;
  panelTimeZone: string;
}) {
  const { regionalFormatPreference, displayTimeZonePreference, panelTimeZone } = inputs;
  const resolvedRegionalFormatLocale = resolveRegionalFormatLocale(regionalFormatPreference);
  const browserTimeZone = useMemo(() => detectedBrowserTimeZone(), []);
  const displayTimeZone = resolveDisplayTimeZone(displayTimeZonePreference, panelTimeZone, browserTimeZone);

  const dateTimeFormatter = useMemo(() => new Intl.DateTimeFormat(resolvedRegionalFormatLocale, { dateStyle: "medium", timeStyle: "short", timeZone: displayTimeZone }), [resolvedRegionalFormatLocale, displayTimeZone]);
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(resolvedRegionalFormatLocale, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: displayTimeZone }), [resolvedRegionalFormatLocale, displayTimeZone]);
  const shortTimeFormatter = useMemo(() => new Intl.DateTimeFormat(resolvedRegionalFormatLocale, { hour: "2-digit", minute: "2-digit", timeZone: displayTimeZone }), [resolvedRegionalFormatLocale, displayTimeZone]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(resolvedRegionalFormatLocale), [resolvedRegionalFormatLocale]);

  const formatDisplayDate = useCallback((value: string | number | Date) => dateTimeFormatter.format(new Date(value)), [dateTimeFormatter]);
  const formatDisplayTime = useCallback((value: string | number | Date) => timeFormatter.format(new Date(value)), [timeFormatter]);
  const formatDisplayShortTime = useCallback((value: string | number | Date) => shortTimeFormatter.format(new Date(value)), [shortTimeFormatter]);
  const formatDisplayNumber = useCallback((value: number) => numberFormatter.format(value), [numberFormatter]);

  return {
    browserTimeZone,
    displayTimeZone,
    dateTimeFormatter,
    formatDisplayDate,
    formatDisplayTime,
    formatDisplayShortTime,
    formatDisplayNumber
  };
}
