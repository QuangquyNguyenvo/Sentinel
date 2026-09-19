import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulateExposure,
  accumulateHeatInjuryDose,
  heatDoseIncrement,
  smokeMovementFactor,
} from '../src/hazard-exposure.js';

const tolerance = (heat) => heat > 0 ? 10 : Infinity;

test('optical smoke alone never incapacitates or adds heat dose', () => {
  const result = accumulateExposure({
    heatDose: 0,
    smokeDensity: 1.4,
    heatFlux: 0,
    deltaSeconds: 900,
    heatToleranceTime: tolerance,
  });
  assert.equal(result.heatDose, 0);
  assert.equal(result.incapacitated, false);
  assert.ok(result.smokeVisibilityExposure > 0);
});

test('heat dose uses tolerance time and marks injury as incapacitation', () => {
  assert.equal(heatDoseIncrement({ heatFlux: 10, deltaSeconds: 5, heatToleranceTime: tolerance }), 0.5);
  assert.equal(accumulateHeatInjuryDose(0.5, 10, 5, tolerance), 1);
  const result = accumulateExposure({ heatDose: 0.75, heatFlux: 10, deltaSeconds: 5, heatToleranceTime: tolerance });
  assert.equal(result.incapacitated, true);
  assert.equal(result.heatDose, 1.25);
});

test('smoke movement factor slows without reaching zero', () => {
  assert.equal(smokeMovementFactor(0), 1);
  assert.equal(smokeMovementFactor(4), 0.3);
});

