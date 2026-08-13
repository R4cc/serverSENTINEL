/**
 * The plain-language reading of a cron expression comes from @serversentinel/contracts, so the
 * editor, the schedules table, and anything the panel says about the same expression agree. Kept as
 * a re-export because both the page and its tests have always imported it from here.
 */
export { describeCronExpression } from "@serversentinel/contracts";
