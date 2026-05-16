// ============================================================
// eventTypes.js — shared event-type display mapping
// ============================================================
// INTR_DISPLAY_TYPE maps an `interruptions.type` value to its display
// category. The stored value is either an interruption subtype
// (e.g. "excursion") or a top-level synced type written directly
// (e.g. "performance"). Consumed by CalendarManager.js,
// weeklyTimetableGenerator.js, and WeeklyAdjustments.js.
//
// EVENT_TYPE_META and INTERRUPTION_SUBTYPES are deliberately NOT
// shared here — CalendarManager.js and Dashboard.js keep their own
// copies (different shapes/palettes). Keep those two in sync by hand.
//
// v2.9.0: "school_event" display category retired — every subtype
// that previously displayed as school_event now displays as
// interruption. No `personal` entry — Personal never reaches the
// interruptions table.

export const INTR_DISPLAY_TYPE = {
  // interruption subtypes (union of CalendarManager + Dashboard lists)
  student_free:   "interruption",
  curriculum_day: "interruption",
  excursion:      "interruption", // was school_event (retired v2.9.0)
  carnival:       "interruption", // was school_event (retired v2.9.0)
  swimming:       "interruption", // was school_event (retired v2.9.0)
  assembly:       "interruption", // was school_event (retired v2.9.0)
  camp:           "interruption",
  photos:         "interruption", // was school_event (retired v2.9.0)
  concert:        "performance",
  other:          "interruption",
  // top-level types written directly into interruptions.type
  public_holiday: "public_holiday",
  performance:    "performance",
  staff_event:    "staff_event",
};
