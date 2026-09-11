'use strict';

// Exercise the dependency-free decoder with complete reports. The same body
// cases must work in observations and forecasts without changing raw text.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../webapp/weather.js'), 'utf8'), context);
const { interpretMetar, interpretTaf } = context.window.VoxHFWeather;
const value = (report, label) => report.rows.find(row => row.label === label)?.value;
const cases = [
  ['12007MPS', 'Wind', '120 degrees at 7 m/s (~14 kt)'],
  ['12007G13MPS', 'Wind', '120 degrees at 7 m/s (~14 kt), gusting 13 m/s (~25 kt)'],
  ['VRB03MPS', 'Wind', 'variable at 3 m/s (~6 kt)'],
  ['VRB03G10MPS', 'Wind', 'variable at 3 m/s (~6 kt), gusting 10 m/s (~19 kt)'],
  ['00000MPS', 'Wind', 'Calm, 0 m/s (~0 kt)'],
  ['00000KT', 'Wind', 'Calm, 0 kt'],
  ['27015G25KT', 'Wind', '270 degrees at 15 kt, gusting 25 kt'],
  ['270100G120KT', 'Wind', '270 degrees at 100 kt, gusting 120 kt'],
  ['090V150', 'Wind variation', '90 to 150 degrees'],
  ['1 1/2SM', 'Visibility', '1 1/2 statute miles'],
  ['2 3/4SM', 'Visibility', '2 3/4 statute miles'],
  ['1/2SM', 'Visibility', '1/2 statute miles'],
  ['10SM', 'Visibility', '10 statute miles'],
  ['M1/4SM', 'Visibility', 'Less than 1/4 statute miles'],
  ['P6SM', 'Visibility', 'More than 6 statute miles'],
  ['0000', 'Visibility', 'Less than 50 m'],
  ['0050', 'Visibility', '50 m'],
  ['9999', 'Visibility', '10 km or more'],
  ['////', 'Visibility', 'Not available'],
  ['//////', 'Cloud', 'Not available'],
  ['BKN050CB', 'Cloud BKN050CB', 'broken cloud layer at 5000 ft, cumulonimbus'],
  ['VV///', 'Cloud VV///', 'vertical visibility at height unknown'],
  ['18/14', 'Temperature', '18 C, dewpoint 14 C'],
  ['M04/M07', 'Temperature', '-04 C, dewpoint -07 C'],
  ['Q1015', 'QNH', '1015 hPa'],
  ['A2992', 'Altimeter', '29.92 inHg'],
  ['VCTS', 'Weather VCTS', 'in the vicinity thunderstorm'],
];
for (const [body, label, expected] of cases) {
  for (const [decode, header, prefix] of [
    [interpretMetar, 'METAR EGLL 051400Z', ''],
    [interpretTaf, 'TAF EGLL 051400Z 0515/0615', 'Base forecast '],
  ]) {
    const parsed = decode(`${header} ${body}=\n`);
    assert.ok(parsed, body);
    assert.strictEqual(value(parsed, prefix + label), expected, body);
    assert.ok(!value(parsed, 'Not interpreted'), body);
    assert.strictEqual(parsed.rows.filter(row => row.label === prefix + label).length, 1, body);
  }
}

const original = 'UAAA 051400Z 12007MPS 9999 VCTS BKN050CB OVC100 18/14 Q1015 NOSIG';
const observation = interpretMetar(original);
assert.strictEqual(value(observation, 'Wind'), '120 degrees at 7 m/s (~14 kt)');
assert.strictEqual(value(observation, 'Trend'), 'No significant change expected');
assert.ok(!value(observation, 'Not interpreted'));
for (const type of ['METAR', 'SPECI']) {
  const corrected = interpretMetar(`${type} COR EGLL 051400Z AUTO 27015KT 1 1/2SM BKN010 18/14 Q1015 RMK KEEP 12007MPS 0000 1 1/2SM`);
  assert.strictEqual(value(corrected, 'Report'), `${type} COR for EGLL`);
  assert.strictEqual(value(corrected, 'Visibility'), '1 1/2 statute miles');
  assert.strictEqual(value(corrected, 'Remarks'), 'KEEP 12007MPS 0000 1 1/2SM');
}
assert.ok(interpretMetar('EGLL 051400Z COR 27015KT 9999 Q1015'));
assert.ok(interpretMetar('metar cor egll 051400z 12007mps 9999 q1015= '));
assert.strictEqual(interpretMetar('METAR COR 051400Z 12007MPS'), null);
assert.strictEqual(interpretMetar(''), null);
assert.strictEqual(interpretTaf(null), null);

const forecast = interpretTaf('TAF COR UAAA 051400Z 0515/0615 12007MPS 1 1/2SM BKN050 TEMPO 0516/0518 12007G13MPS 0000 BECMG 0518/0520 9999 FM052100 VRB03MPS P6SM PROB30 TEMPO 0601/0604 M1/4SM FG RMK SENSOR NOTE');
assert.strictEqual(value(forecast, 'Report'), 'TAF COR');
assert.strictEqual(value(forecast, 'Base forecast Visibility'), '1 1/2 statute miles');
assert.strictEqual(value(forecast, 'Temporary Wind'), '120 degrees at 7 m/s (~14 kt), gusting 13 m/s (~25 kt)');
assert.strictEqual(value(forecast, 'Temporary Visibility'), 'Less than 50 m');
assert.strictEqual(value(forecast, 'Becoming Visibility'), '10 km or more');
assert.strictEqual(value(forecast, 'From day 05 at 21:00Z Wind'), 'variable at 3 m/s (~6 kt)');
assert.strictEqual(value(forecast, 'From day 05 at 21:00Z Visibility'), 'More than 6 statute miles');
assert.strictEqual(value(forecast, 'Probability 30% temporary Visibility'), 'Less than 1/4 statute miles');
assert.strictEqual(value(forecast, 'Probability 30% temporary Remarks'), 'SENSOR NOTE');
assert.ok(!value(forecast, 'Not interpreted'));
assert.strictEqual(value(interpretTaf('TAF AMD EGLL 051400Z 0515/0615 00000MPS CAVOK'), 'Report'), 'TAF AMD');

for (const decode of [interpretMetar, interpretTaf]) {
  const header = decode === interpretMetar ? 'EGLL 051400Z' : 'TAF EGLL 051400Z 0515/0615';
  const parsed = decode(`${header} 1/0SM 12007XYZ UNKNOWN RMK 1 1/2SM`);
  assert.ok(value(parsed, 'Not interpreted').includes('1/0SM'));
  assert.ok(value(parsed, 'Not interpreted').includes('12007XYZ'));
  assert.ok(value(parsed, 'Not interpreted').includes('UNKNOWN'));
}
console.log(`[OK] ${cases.length * 2} shared METAR/TAF cases plus corrected reports, forecast sections, remarks and unknown groups`);
