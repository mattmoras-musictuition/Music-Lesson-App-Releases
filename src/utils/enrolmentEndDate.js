// ============================================================
// enrolmentEndDate.js — editing an ended enrolment's end date.
// Pure functions, no side effects, no state.
//
// v2.44.0 — the end date of an ENDED enrolment is editable from the History
// section of the student form. Editing it changes the date only: it never
// adds or removes lessons, misses or master cards, and never runs the
// End-enrolment cascade. That holds because the cascade fires only for
// enrolments that are newly ended by a save (newlyEndedEnrolments below), and
// an enrolment whose end date is being edited was already ended before the
// form opened.
//
// Dates are plain YYYY-MM-DD strings (what <input type="date"> yields), so a
// string compare is the date compare and there is no timezone day-shift.
// ============================================================

// Returns an error message for an invalid end date, or null when it is fine.
// `today` is the Melbourne date (melbourneToday()), supplied by the caller.
export function validateEndDateEdit(value, startDate, today) {
  if (!value) return "Enter an end date.";
  if (startDate && value < startDate) return "End date can't be before the start date.";
  if (today && value > today) return "End date can't be in the future.";
  return null;
}

// The end date can be edited only on an enrolment that was already ended
// when the form opened (`priorEnrolments` = the saved rows). One ended during
// this form session has not been saved yet, and its date is what the
// End-enrolment cascade will clear forward from, so it stays read-only until
// saved.
export function isEndDateEditable(enrolment, priorEnrolments) {
  if (!enrolment || !enrolment.endDate) return false;
  const prior = (priorEnrolments || []).find(p => p.id === enrolment.id);
  return !!(prior && prior.endDate);
}

// Change one enrolment's endDate and nothing else.
export function applyEndDateEdit(formEnrolments, enrolmentId, value) {
  return (formEnrolments || []).map(e => e.id === enrolmentId ? { ...e, endDate: value } : e);
}

// The enrolments a save newly ends — each one gets the End-enrolment card
// cascade. Ones already ended before the form opened are ignored, whatever
// their end date now says, so an end-date edit never triggers a cascade.
export function newlyEndedEnrolments(formEnrolments, priorEnrolments) {
  return (formEnrolments || [])
    .filter(e => e.endDate && !(priorEnrolments || []).find(p => p.id === e.id)?.endDate)
    .map(e => ({ id: e.id, endDate: e.endDate }));
}
