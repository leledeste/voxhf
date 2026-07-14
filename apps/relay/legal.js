'use strict';

// Legal versions are deployment-specific and independent from the application
// version. An operator changes them only when the corresponding document does.
module.exports = Object.freeze({
  termsVersion: legalValue(process.env.VOXHF_LEGAL_TERMS_VERSION, '1.0'),
  privacyVersion: legalValue(process.env.VOXHF_LEGAL_PRIVACY_VERSION, '1.0'),
  effectiveDate: legalValue(process.env.VOXHF_LEGAL_EFFECTIVE_DATE, ''),
});

function legalValue(value, fallback) {
  const text = String(value || '').trim();
  if (!text || text.length > 40 || !/^[a-z0-9._-]+$/i.test(text)) return fallback;
  return text;
}
