/**
 * Pure exposure bookkeeping used by the evacuation preview.
 *
 * Optical smoke is a visibility and movement problem in this model.  It is
 * deliberately not converted into a toxic FED because the fire model does
 * not provide a species concentration (for example CO or HCN).  Radiant heat
 * is the only accumulated injury dose here, using the tolerance time supplied
 * by the fire model.
 */

function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

/** Return the fractional heat injury dose for a time step. */
export function heatDoseIncrement({ heatFlux = 0, deltaSeconds = 0, heatToleranceTime } = {}) {
  const seconds = nonNegative(deltaSeconds);
  if (!seconds || typeof heatToleranceTime !== 'function') return 0;
  const tolerance = Number(heatToleranceTime(nonNegative(heatFlux)));
  return Number.isFinite(tolerance) && tolerance > 0 ? seconds / tolerance : 0;
}

/**
 * Integrate one hazard update.
 *
 * `smokeVisibilityExposure` is an optional, nonlethal visibility-hours-like
 * accumulator.  Keeping it in the return value makes the separation between
 * visibility and injury explicit while allowing callers to display or analyse
 * smoke exposure later.  It never contributes to `heatDose`.
 */
export function accumulateExposure({
  heatDose = 0,
  smokeVisibilityExposure = 0,
  heatFlux = 0,
  smokeDensity = 0,
  deltaSeconds = 0,
  heatToleranceTime,
  smokeReferenceDensity = 0.5,
} = {}) {
  const seconds = nonNegative(deltaSeconds);
  const dose = nonNegative(heatDose);
  const smoke = nonNegative(smokeDensity);
  const reference = nonNegative(smokeReferenceDensity, 0.5) || 0.5;
  const heatIncrement = heatDoseIncrement({ heatFlux, deltaSeconds: seconds, heatToleranceTime });
  const nextHeatDose = dose + heatIncrement;
  const visibilityIncrement = seconds * Math.min(1, smoke / reference);
  const nextVisibilityExposure = nonNegative(smokeVisibilityExposure) + visibilityIncrement;
  return {
    heatDose: nextHeatDose,
    heatInjuryFraction: heatIncrement,
    smokeVisibilityExposure: nextVisibilityExposure,
    incapacitated: nextHeatDose >= 1,
    // A compatibility alias for renderers that historically called this dose.
    dose: nextHeatDose,
  };
}

/** Integrate heat only, for callers that do not need visibility bookkeeping. */
export function accumulateHeatInjuryDose(previousDose, heatFlux, deltaSeconds, heatToleranceTime) {
  return heatDoseIncrement({ heatFlux, deltaSeconds, heatToleranceTime }) + nonNegative(previousDose);
}

/** A small, bounded movement factor derived from optical smoke density. */
export function smokeMovementFactor(smokeDensity, {
  minimum = 0.3,
  coefficient = 0.5,
  referenceDensity = 1,
} = {}) {
  const density = nonNegative(smokeDensity);
  const reference = nonNegative(referenceDensity, 1) || 1;
  const floor = Math.min(1, Math.max(0, Number(minimum) || 0));
  const factor = 1 - coefficient * density / reference;
  return Math.max(floor, Math.min(1, factor));
}

// Descriptive aliases make the helper convenient for small consumers and
// preserve a stable name if the UI's terminology changes later.
export const integrateHazardExposure = accumulateExposure;
export const updateExposure = accumulateExposure;

