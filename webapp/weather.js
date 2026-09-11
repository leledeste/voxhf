(function () {
  const METAR_CLOUDS = {
    FEW: 'few clouds',
    SCT: 'scattered clouds',
    BKN: 'broken cloud layer',
    OVC: 'overcast',
    NSC: 'no significant cloud',
    NCD: 'no cloud detected',
    VV: 'vertical visibility',
  };

  const METAR_WEATHER = {
    MI: 'shallow',
    PR: 'partial',
    BC: 'patches',
    DR: 'low drifting',
    BL: 'blowing',
    SH: 'showers',
    TS: 'thunderstorm',
    FZ: 'freezing',
    DZ: 'drizzle',
    RA: 'rain',
    SN: 'snow',
    SG: 'snow grains',
    IC: 'ice crystals',
    PL: 'ice pellets',
    GR: 'hail',
    GS: 'small hail or snow pellets',
    UP: 'unknown precipitation',
    BR: 'mist',
    FG: 'fog',
    FU: 'smoke',
    VA: 'volcanic ash',
    DU: 'widespread dust',
    SA: 'sand',
    HZ: 'haze',
    PY: 'spray',
    PO: 'dust or sand whirls',
    SQ: 'squalls',
    FC: 'funnel cloud, tornado, or waterspout',
    SS: 'sandstorm',
    DS: 'duststorm',
  };

  function signedTemperature(token) {
    return token.startsWith('M') ? `-${token.slice(1)}` : token;
  }

  function weatherTokens(raw) {
    const tokens = String(raw || '').trim().replace(/=$/, '').trim().toUpperCase().split(/\s+/);
    // A mixed statute-mile value is one group even though it contains a space.
    // Merge before decoding so its integer part cannot be lost or read as metres.
    for (let i = 0; i < tokens.length - 1; i += 1) {
      if (/^[MP]?\d{1,2}$/.test(tokens[i]) && /^\d+\/[1-9]\d*SM$/.test(tokens[i + 1])) {
        tokens.splice(i, 2, `${tokens[i]} ${tokens[i + 1]}`);
      }
    }
    return tokens;
  }

  function windSpeed(value, unit) {
    const speed = Number(value);
    // Preserve the reported unit; the rounded knot value is supplementary.
    return unit === 'MPS' ? `${speed} m/s (~${Math.round(speed * 3600 / 1852)} kt)` : `${speed} kt`;
  }

  function cloudHeight(token) {
    if (!token || token === '///') return 'height unknown';
    return `${Number(token) * 100} ft`;
  }

  function decodeMetarWeather(token) {
    // METAR weather groups are built from optional intensity/proximity plus
    // two-letter descriptors and phenomena. Decode known chunks and keep the
    // original code visible through the row label.
    let rest = token;
    const parts = [];
    if (rest.startsWith('-')) {
      parts.push('light');
      rest = rest.slice(1);
    } else if (rest.startsWith('+')) {
      parts.push('heavy');
      rest = rest.slice(1);
    }
    if (rest.startsWith('VC')) {
      parts.push('in the vicinity');
      rest = rest.slice(2);
    }
    for (let i = 0; i < rest.length; i += 2) {
      const code = rest.slice(i, i + 2);
      if (!METAR_WEATHER[code]) return '';
      parts.push(METAR_WEATHER[code]);
    }
    return parts.join(' ');
  }

  function validityPeriod(token) {
    const match = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(token);
    if (!match) return '';
    return `Day ${match[1]} ${match[2]}:00Z to day ${match[3]} ${match[4]}:00Z`;
  }

  function fromTime(token) {
    const match = /^FM(\d{2})(\d{2})(\d{2})$/.exec(token);
    if (!match) return '';
    return `From day ${match[1]} at ${match[2]}:${match[3]}Z`;
  }

  function appendUnavailableConditionRow(token, rows, context = '') {
    // Some international reports replace an unavailable visibility or cloud
    // group with solidi. Keep the missing value explicit instead of treating
    // the placeholder as an unknown weather code.
    const unavailable = token === '////'
      ? {
          label: 'Visibility',
          value: 'Not available',
          hint: 'The visibility field contains solidi because no usable value was reported.',
        }
      : token === '//////'
        ? {
            label: 'Cloud',
            value: 'Not available',
            hint: 'The cloud field contains solidi because no usable cloud amount or base was reported.',
          }
        : null;
    if (!unavailable) return false;
    rows.push({
      ...unavailable,
      label: `${context}${unavailable.label}`.trim(),
    });
    return true;
  }

  function appendRemarks(tokens, rows, context = '') {
    const original = tokens.join(' ').trim();
    if (!original) return;

    const ceilometer = /^CLD FROM CEILOMETER RWY (\d{2}[LCR]?) NCD$/.exec(original);
    rows.push({
      label: `${context}Remarks`.trim(),
      value: ceilometer
        ? `Runway ${ceilometer[1]} ceilometer: no cloud detected`
        : original,
      hint: ceilometer
        ? `Decoded from the original remark: ${original}`
        : 'Supplementary station remarks are preserved in their original form.',
    });
  }

  function appendConditionTokenRows(token, rows, unparsed, context = '') {
    // Forecast and METAR body groups share many codes. This helper keeps TAF
    // sections readable without pretending to solve every possible group.
    if (!token || token === 'AUTO' || token === 'COR') return true;

    if (appendUnavailableConditionRow(token, rows, context)) return true;

    if (token === 'CAVOK') {
      rows.push({
        label: `${context}Visibility/cloud`.trim(),
        value: 'Ceiling and visibility OK',
        hint: 'CAVOK means visibility 10 km or more, no significant weather, and no relevant low cloud.',
      });
      return true;
    }

    const wind = /^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(token);
    if (wind) {
      const direction = wind[1] === 'VRB' ? 'variable' : `${Number(wind[1])} degrees`;
      const gust = wind[3] ? `, gusting ${windSpeed(wind[3], wind[4])}` : '';
      const calm = wind[1] === '000' && Number(wind[2]) === 0 && !wind[3];
      rows.push({
        label: `${context}Wind`.trim(),
        value: `${calm ? 'Calm, ' : `${direction} at `}${windSpeed(wind[2], wind[4])}${gust}`,
        hint: 'Direction is where the wind blows from, in degrees true. MPS means metres per second; the knot equivalent is approximate.',
      });
      return true;
    }

    const variableWind = /^(\d{3})V(\d{3})$/.exec(token);
    if (variableWind) {
      rows.push({
        label: `${context}Wind variation`.trim(),
        value: `${Number(variableWind[1])} to ${Number(variableWind[2])} degrees`,
        hint: 'Variable direction range reported when wind direction changes significantly.',
      });
      return true;
    }

    if (/^\d{4}$/.test(token)) {
      rows.push({
        label: `${context}Visibility`.trim(),
        value: token === '9999' ? '10 km or more' : token === '0000' ? 'Less than 50 m' : `${Number(token)} m`,
        hint: 'Prevailing visibility in metres. 0000 means less than 50 m; 9999 means 10 km or more.',
      });
      return true;
    }

    const miles = /^([MP]?)(\d+(?: \d+\/[1-9]\d*|\/[1-9]\d*)?)SM$/.exec(token);
    if (miles) {
      rows.push({
        label: `${context}Visibility`.trim(),
        value: `${miles[1] === 'M' ? 'Less than ' : miles[1] === 'P' ? 'More than ' : ''}${miles[2]} statute miles`,
        hint: 'Visibility in statute miles, common in US-style METARs.',
      });
      return true;
    }

    const weather = decodeMetarWeather(token);
    if (weather) {
      rows.push({
        label: `${context}Weather ${token}`.trim(),
        value: weather,
        hint: 'Weather group: intensity/proximity, descriptor, and phenomenon.',
      });
      return true;
    }

    const cloud = /^(FEW|SCT|BKN|OVC|NSC|NCD|VV)(\d{3}|\/\/\/)?(CB|TCU)?$/.exec(token);
    if (cloud) {
      const convective = cloud[3] === 'CB' ? ', cumulonimbus' : cloud[3] === 'TCU' ? ', towering cumulus' : '';
      rows.push({
        label: `${context}Cloud ${token}`.trim(),
        value: `${METAR_CLOUDS[cloud[1]] || cloud[1]}${cloud[2] ? ` at ${cloudHeight(cloud[2])}` : ''}${convective}`,
        hint: 'Cloud cover amount and base height. Heights are hundreds of feet above aerodrome elevation.',
      });
      return true;
    }

    const temp = /^(M?\d{2})\/(M?\d{2})$/.exec(token);
    if (temp) {
      rows.push({
        label: `${context}Temperature`.trim(),
        value: `${signedTemperature(temp[1])} C, dewpoint ${signedTemperature(temp[2])} C`,
        hint: 'Temperature and dewpoint in Celsius. M means below zero.',
      });
      return true;
    }

    const qnh = /^Q(\d{4})$/.exec(token);
    if (qnh) {
      rows.push({
        label: `${context}QNH`.trim(),
        value: `${Number(qnh[1])} hPa`,
        hint: 'Altimeter setting in hectopascals.',
      });
      return true;
    }

    const altimeter = /^A(\d{4})$/.exec(token);
    if (altimeter) {
      rows.push({
        label: `${context}Altimeter`.trim(),
        value: `${altimeter[1].slice(0, 2)}.${altimeter[1].slice(2)} inHg`,
        hint: 'Altimeter setting in inches of mercury.',
      });
      return true;
    }

    if (token === 'NSW') {
      rows.push({
        label: `${context}Weather`.trim(),
        value: 'No significant weather',
        hint: 'NSW is used in forecasts when significant weather is expected to end.',
      });
      return true;
    }

    unparsed.push(context ? `${context}${token}` : token);
    return false;
  }

  function interpretMetar(raw) {
    // The interpreter is deliberately conservative: recognized groups become
    // readable rows, while unknown tokens remain listed instead of being guessed.
    const tokens = weatherTokens(raw);
    const rows = [];
    const unparsed = [];
    let index = 0;

    if (/^(METAR|SPECI)$/i.test(tokens[index])) index += 1;
    const type = index > 0 ? tokens[index - 1].toUpperCase() : 'METAR';
    const corrected = tokens[index] === 'COR';
    if (corrected) index += 1;
    const station = /^[A-Z]{4}$/.test(tokens[index] || '') ? tokens[index++] : '';
    const time = /^(\d{2})(\d{2})(\d{2})Z$/.exec(tokens[index] || '');
    if (!station || !time) return null;

    rows.push({
      label: 'Report',
      value: `${type}${corrected ? ' COR' : ''} for ${station}`,
      hint: 'METAR is a routine aviation weather observation. SPECI is a special observation. COR means corrected.',
    });
    rows.push({
      label: 'Observed',
      value: `Day ${time[1]} at ${time[2]}:${time[3]}Z`,
      hint: 'The timestamp is UTC: day of month, hour, and minute.',
    });
    index += 1;

    for (; index < tokens.length; index += 1) {
      const token = tokens[index].toUpperCase();
      if (!token || token === 'AUTO' || token === 'COR') continue;

      if (token === 'RMK') {
        appendRemarks(tokens.slice(index + 1).map(value => value.toUpperCase()), rows);
        break;
      }

      if (token === 'NOSIG') {
        rows.push({
          label: 'Trend',
          value: 'No significant change expected',
          hint: 'NOSIG means no significant weather change is forecast in the trend period.',
        });
        continue;
      }

      if (/^(TEMPO|BECMG|PROB\d{2})$/.test(token)) {
        rows.push({
          label: 'Trend',
          value: token,
          hint: 'Forecast trend group. TEMPO means temporary, BECMG means becoming, PROB gives probability.',
        });
        continue;
      }

      appendConditionTokenRows(token, rows, unparsed);
    }

    if (unparsed.length) {
      rows.push({
        label: 'Not interpreted',
        value: unparsed.join(' '),
        hint: 'These METAR groups were left unchanged because the visual parser does not recognize them yet.',
      });
    }

    return rows.length ? { rows } : null;
  }

  function interpretTaf(raw) {
    // TAF is a forecast split into a base period plus change groups. The parser
    // keeps each change marker visible, then decodes the weather groups inside.
    const tokens = weatherTokens(raw);
    const rows = [];
    const unparsed = [];
    let index = 0;

    if ((tokens[index] || '').toUpperCase() === 'TAF') index += 1;
    if (/^(AMD|COR)$/i.test(tokens[index] || '')) {
      rows.push({
        label: 'Report',
        value: `TAF ${tokens[index].toUpperCase()}`,
        hint: 'AMD means amended forecast. COR means corrected forecast.',
      });
      index += 1;
    }

    const station = /^[A-Z]{4}$/.test(tokens[index] || '') ? tokens[index++] : '';
    const issued = /^(\d{2})(\d{2})(\d{2})Z$/.exec(tokens[index] || '');
    if (!station || !issued) return null;

    if (!rows.length) {
      rows.push({
        label: 'Report',
        value: `TAF for ${station}`,
        hint: 'TAF is an aerodrome forecast.',
      });
    } else {
      rows.push({
        label: 'Station',
        value: station,
        hint: 'ICAO airport identifier for this TAF.',
      });
    }
    rows.push({
      label: 'Issued',
      value: `Day ${issued[1]} at ${issued[2]}:${issued[3]}Z`,
      hint: 'The issue timestamp is UTC: day of month, hour, and minute.',
    });
    index += 1;

    const validity = validityPeriod(tokens[index] || '');
    if (!validity) return null;
    rows.push({
      label: 'Valid',
      value: validity,
      hint: 'TAF validity period in UTC.',
    });
    index += 1;

    let section = 'Base forecast';
    rows.push({
      label: section,
      value: 'Initial forecast conditions',
      hint: 'Base conditions valid unless changed by later forecast groups.',
    });

    for (; index < tokens.length; index += 1) {
      const token = tokens[index].toUpperCase();

      if (token === 'RMK') {
        appendRemarks(
          tokens.slice(index + 1).map(value => value.toUpperCase()),
          rows,
          `${section} `,
        );
        break;
      }

      const fm = fromTime(token);
      if (fm) {
        section = fm;
        rows.push({
          label: 'From',
          value: fm,
          hint: 'FM starts a new set of conditions from this exact UTC time.',
        });
        continue;
      }

      if (token === 'TEMPO' || token === 'BECMG') {
        const period = validityPeriod(tokens[index + 1] || '');
        section = token === 'TEMPO' ? 'Temporary' : 'Becoming';
        rows.push({
          label: section,
          value: period || 'period not decoded',
          hint: token === 'TEMPO'
            ? 'TEMPO marks temporary conditions during the given period.'
            : 'BECMG marks a gradual change during the given period.',
        });
        if (period) index += 1;
        continue;
      }

      const probability = /^PROB(\d{2})$/.exec(token);
      if (probability) {
        const next = (tokens[index + 1] || '').toUpperCase();
        const period = next === 'TEMPO'
          ? validityPeriod(tokens[index + 2] || '')
          : validityPeriod(tokens[index + 1] || '');
        section = next === 'TEMPO'
          ? `Probability ${probability[1]}% temporary`
          : `Probability ${probability[1]}%`;
        rows.push({
          label: section,
          value: period || 'period not decoded',
          hint: 'PROB gives the probability of the following forecast conditions.',
        });
        if (next === 'TEMPO' && period) index += 2;
        else if (period) index += 1;
        continue;
      }

      if (token === 'NOSIG') {
        rows.push({
          label: `${section} trend`,
          value: 'No significant change expected',
          hint: 'NOSIG means no significant weather change is forecast in the trend period.',
        });
        continue;
      }

      appendConditionTokenRows(token, rows, unparsed, `${section} `);
    }

    if (unparsed.length) {
      rows.push({
        label: 'Not interpreted',
        value: unparsed.join(' '),
        hint: 'These TAF groups were left unchanged because the visual parser does not recognize them yet.',
      });
    }

    return rows.length ? { rows } : null;
  }

  window.VoxHFWeather = {
    interpretMetar,
    interpretTaf,
  };
}());
