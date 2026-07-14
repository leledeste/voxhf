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

  function appendConditionTokenRows(token, rows, unparsed, context = '') {
    // Forecast and METAR body groups share many codes. This helper keeps TAF
    // sections readable without pretending to solve every possible group.
    if (!token || token === 'AUTO' || token === 'COR') return true;

    if (token === 'CAVOK') {
      rows.push({
        label: `${context}Visibility/cloud`.trim(),
        value: 'Ceiling and visibility OK',
        hint: 'CAVOK means visibility 10 km or more, no significant weather, and no relevant low cloud.',
      });
      return true;
    }

    const wind = /^(VRB|\d{3})(\d{2,3})(G(\d{2,3}))?KT$/.exec(token);
    if (wind) {
      const direction = wind[1] === 'VRB' ? 'variable' : `${Number(wind[1])} degrees`;
      const gust = wind[4] ? `, gusting ${Number(wind[4])} kt` : '';
      rows.push({
        label: `${context}Wind`.trim(),
        value: `${direction} at ${Number(wind[2])} kt${gust}`,
        hint: 'Wind is reported as direction from which it blows, then speed in knots.',
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
        value: token === '9999' ? '10 km or more' : `${Number(token)} m`,
        hint: 'Prevailing visibility in meters. 9999 means 10 km or more.',
      });
      return true;
    }

    if (/^\d+(\/\d+)?SM$/.test(token)) {
      rows.push({
        label: `${context}Visibility`.trim(),
        value: `${token.replace('SM', '')} statute miles`,
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
    const text = String(raw || '').replace(/=$/, '').trim();
    if (!text) return null;
    const tokens = text.split(/\s+/);
    const rows = [];
    const unparsed = [];
    let index = 0;

    if (/^(METAR|SPECI)$/i.test(tokens[index])) index += 1;
    const type = index > 0 ? tokens[index - 1].toUpperCase() : 'METAR';
    const station = /^[A-Z]{4}$/.test(tokens[index] || '') ? tokens[index++] : '';
    const time = /^(\d{2})(\d{2})(\d{2})Z$/.exec(tokens[index] || '');
    if (!station || !time) return null;

    rows.push({
      label: 'Report',
      value: `${type} for ${station}`,
      hint: 'METAR is a routine aviation weather observation. SPECI is a special observation.',
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

      if (token === 'CAVOK') {
        rows.push({
          label: 'Visibility/cloud',
          value: 'Ceiling and visibility OK',
          hint: 'CAVOK means visibility 10 km or more, no significant weather, and no relevant low cloud.',
        });
        continue;
      }

      const wind = /^(VRB|\d{3})(\d{2,3})(G(\d{2,3}))?KT$/.exec(token);
      if (wind) {
        const direction = wind[1] === 'VRB' ? 'variable' : `${Number(wind[1])} degrees`;
        const gust = wind[4] ? `, gusting ${Number(wind[4])} kt` : '';
        rows.push({
          label: 'Wind',
          value: `${direction} at ${Number(wind[2])} kt${gust}`,
          hint: 'Wind is reported as direction from which it blows, then speed in knots.',
        });
        continue;
      }

      const variableWind = /^(\d{3})V(\d{3})$/.exec(token);
      if (variableWind) {
        rows.push({
          label: 'Wind variation',
          value: `${Number(variableWind[1])} to ${Number(variableWind[2])} degrees`,
          hint: 'Variable direction range reported when wind direction changes significantly.',
        });
        continue;
      }

      if (/^\d{4}$/.test(token)) {
        rows.push({
          label: 'Visibility',
          value: token === '9999' ? '10 km or more' : `${Number(token)} m`,
          hint: 'Prevailing visibility in meters. 9999 means 10 km or more.',
        });
        continue;
      }

      if (/^\d+(\/\d+)?SM$/.test(token)) {
        rows.push({
          label: 'Visibility',
          value: `${token.replace('SM', '')} statute miles`,
          hint: 'Visibility in statute miles, common in US-style METARs.',
        });
        continue;
      }

      const weather = decodeMetarWeather(token);
      if (weather) {
        rows.push({
          label: `Weather ${token}`,
          value: weather,
          hint: 'Weather group: intensity/proximity, descriptor, and phenomenon.',
        });
        continue;
      }

      const cloud = /^(FEW|SCT|BKN|OVC|NSC|NCD|VV)(\d{3}|\/\/\/)?(CB|TCU)?$/.exec(token);
      if (cloud) {
        const convective = cloud[3] === 'CB' ? ', cumulonimbus' : cloud[3] === 'TCU' ? ', towering cumulus' : '';
        rows.push({
          label: `Cloud ${token}`,
          value: `${METAR_CLOUDS[cloud[1]] || cloud[1]}${cloud[2] ? ` at ${cloudHeight(cloud[2])}` : ''}${convective}`,
          hint: 'Cloud cover amount and base height. Heights are hundreds of feet above aerodrome elevation.',
        });
        continue;
      }

      const temp = /^(M?\d{2})\/(M?\d{2})$/.exec(token);
      if (temp) {
        rows.push({
          label: 'Temperature',
          value: `${signedTemperature(temp[1])} C, dewpoint ${signedTemperature(temp[2])} C`,
          hint: 'Temperature and dewpoint in Celsius. M means below zero.',
        });
        continue;
      }

      const qnh = /^Q(\d{4})$/.exec(token);
      if (qnh) {
        rows.push({
          label: 'QNH',
          value: `${Number(qnh[1])} hPa`,
          hint: 'Altimeter setting in hectopascals.',
        });
        continue;
      }

      const altimeter = /^A(\d{4})$/.exec(token);
      if (altimeter) {
        rows.push({
          label: 'Altimeter',
          value: `${altimeter[1].slice(0, 2)}.${altimeter[1].slice(2)} inHg`,
          hint: 'Altimeter setting in inches of mercury.',
        });
        continue;
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

      unparsed.push(token);
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
    const text = String(raw || '').replace(/=$/, '').trim();
    if (!text) return null;
    const tokens = text.split(/\s+/);
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
