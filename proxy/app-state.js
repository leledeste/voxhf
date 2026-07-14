'use strict';

const { normalizeSquawkCode } = require('./fsd-parser');
const { formatComFrequency } = require('./pilot-core');

function createAppState(options) {
  // This object is the local source of truth for UI-visible simulator state.
  // Network modules update it through small methods, and it emits typed events
  // to the local webapp plus the remote relay through the provided publisher.
  const timestamp = options.timestamp;
  const publish = options.publish;

  const messageLog = [];
  const currentComFrequencies = { 1: '', 2: '' };
  const currentComStations = { 1: '', 2: '' };
  const currentXpdrState = { squawk: '', mode: '' };
  const knownStations = new Map();

  let callsign = null;
  let connected = false;
  let flightPlanStatus = 'missing';
  let flightPlan = { departure: '', destination: '', alternate: '' };
  let weatherState = createEmptyWeatherState(flightPlan);
  let ownPosition = null;

  function broadcast(data) {
    // Recording chat history here keeps reconnect snapshots consistent no
    // matter whether a message came from FSD, local UI, or remote control.
    if (data.kind === 'message') {
      messageLog.push(data);
      if (messageLog.length > 200) messageLog.shift();
    }
    publish(data);
  }

  function setConnected(value, notify = true) {
    // Connection events may repeat during reconnect races. Re-broadcasting is
    // intentional: it lets stale browser status recover from old socket closes.
    connected = Boolean(value);
    if (notify) broadcast({ kind: 'status', connected, callsign });
  }

  function setCallsign(value, notify = true) {
    // Callsigns are learned from PilotUI and FSD. The validator keeps accidental
    // protocol fragments out of the user-visible state.
    const next = String(value || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{2,10}$/.test(next) || next === callsign) return false;
    callsign = next;
    if (notify) broadcast({ kind: 'login', callsign, own: true, timestamp: timestamp() });
    return true;
  }

  function updateComFrequency(com, freq, station = '') {
    // Store the latest known COM state. New browser tabs receive this snapshot
    // in their init message, while existing tabs receive the live event.
    const radio = com === 2 ? 2 : 1;
    const value = formatComFrequency(freq);
    if (!value) return false;
    const selectedStation = stationForFrequency(value, station || currentComStations[radio]);
    if (currentComFrequencies[radio] === value && currentComStations[radio] === selectedStation) return false;
    currentComFrequencies[radio] = value;
    currentComStations[radio] = selectedStation;
    broadcast({ kind: 'freq_update', com: radio, freq: value, station: selectedStation });
    return true;
  }

  function stationForFrequency(freq, preferred = '') {
    const value = formatComFrequency(freq);
    const preferredStation = knownStations.get(String(preferred || '').toUpperCase());
    if (preferredStation && formatComFrequency(preferredStation.freq) === value) return preferredStation.callsign;
    if (value === '122.800') return 'UNICOM';

    for (const station of knownStations.values()) {
      if (formatComFrequency(station.freq) === value) return station.callsign;
    }
    return '';
  }

  function updateXpdrState(data, notify = true) {
    // Own FSD position packets carry the transponder state PilotCore is actually
    // sending to IVAO. Store it so browser tabs stay in sync with external
    // transponder changes.
    let changed = false;
    const squawk = normalizeSquawkCode(data.squawk);
    if (squawk && currentXpdrState.squawk !== squawk) {
      currentXpdrState.squawk = squawk;
      changed = true;
    }

    const mode = data.mode || data.xpdrMode;
    if ((mode === 'stby' || mode === 'alt') && currentXpdrState.mode !== mode) {
      currentXpdrState.mode = mode;
      changed = true;
    }

    if (changed && notify) {
      broadcast({
        kind: 'xpdr_update',
        squawk: currentXpdrState.squawk,
        mode: currentXpdrState.mode,
        timestamp: timestamp(),
      });
    }
    return changed;
  }

  function updateFlightPlanStatus(status, nextFlightPlan = null, notify = true) {
    // FSD flight plan errors can repeat often. Keep them as compact UI state
    // instead of filling the chat with identical SERVER messages.
    if (status !== 'filed' && status !== 'missing') return false;
    const nextPlan = status === 'filed'
      ? normalizeFlightPlan(nextFlightPlan, flightPlan)
      : { departure: '', destination: '', alternate: '' };
    const planChanged = !sameFlightPlan(flightPlan, nextPlan);
    if (flightPlanStatus === status && !planChanged) return false;
    flightPlanStatus = status;
    if (planChanged) {
      flightPlan = nextPlan;
      weatherState = createEmptyWeatherState(flightPlan);
    }
    if (notify) {
      broadcast({
        kind: 'flight_plan_status',
        status: flightPlanStatus,
        flightPlan: { ...flightPlan },
        weatherState: getWeatherState(),
        timestamp: timestamp(),
      });
    }
    return true;
  }

  function updateWeather(role, kind, icao, text, notify = true) {
    const slotName = role === 'destination' ? 'destination' : 'departure';
    const weatherKind = kind === 'taf' ? 'taf' : 'metar';
    const code = normalizeIcao(icao);
    if (!code || !weatherState[slotName] || weatherState[slotName].icao !== code) return false;

    weatherState = {
      ...weatherState,
      [slotName]: {
        ...weatherState[slotName],
        [weatherKind]: {
          text: String(text || '').trim(),
          receivedAt: timestamp(),
          source: 'IVAO',
        },
      },
    };

    if (notify) {
      broadcast({
        kind: 'weather_update',
        weatherState: getWeatherState(),
        timestamp: timestamp(),
      });
    }
    return true;
  }

  function roleForWeatherIcao(icao) {
    const code = normalizeIcao(icao);
    if (!code) return '';
    if (flightPlan.departure === code) return 'departure';
    if (flightPlan.destination === code) return 'destination';
    return '';
  }

  function getWeatherState() {
    return {
      departure: {
        ...weatherState.departure,
        metar: weatherState.departure.metar ? { ...weatherState.departure.metar } : null,
        taf: weatherState.departure.taf ? { ...weatherState.departure.taf } : null,
      },
      destination: {
        ...weatherState.destination,
        metar: weatherState.destination.metar ? { ...weatherState.destination.metar } : null,
        taf: weatherState.destination.taf ? { ...weatherState.destination.taf } : null,
      },
    };
  }

  function rememberStation(data) {
    const stationCallsign = String(data.callsign || data.atc || '').toUpperCase();
    if (!stationCallsign || stationCallsign.endsWith('_OBS')) return;
    if (!stationCallsign.includes('_') && stationCallsign !== 'UNICOM') return;

    const current = knownStations.get(stationCallsign) || { callsign: stationCallsign };
    const next = {
      ...current,
      callsign: stationCallsign,
      freq: data.freq || current.freq || '',
      lat: Number.isFinite(Number(data.lat)) ? Number(data.lat) : current.lat,
      lon: Number.isFinite(Number(data.lon)) ? Number(data.lon) : current.lon,
      voice: data.ts2Server || data.server
        ? `${data.ts2Server || data.server}/${data.channelName || data.channel || stationCallsign}`
        : current.voice || '',
    };
    knownStations.set(stationCallsign, next);
  }

  function rememberFsdState(msg) {
    if (msg.kind === 'own_position') {
      ownPosition = { lat: msg.lat, lon: msg.lon };
      updateXpdrState(msg);
      return;
    }

    if (msg.kind === 'atc_detected') rememberStation(msg);
    if (msg.kind === 'atc_voice_info') {
      rememberStation({
        callsign: msg.atc,
        ts2Server: msg.ts2Server,
        channelName: msg.channelName,
      });
    }
  }

  function getStatus() {
    return {
      connected,
      callsign,
      flightPlanStatus,
      flightPlan: { ...flightPlan },
      squawk: currentXpdrState.squawk,
      xpdrMode: currentXpdrState.mode,
    };
  }

  function getRadioState() {
    return {
      com1: currentComFrequencies[1],
      com2: currentComFrequencies[2],
      station1: currentComStations[1],
      station2: currentComStations[2],
    };
  }

  function getStationsState() {
    return {
      stations: Array.from(knownStations.values()),
      ownPosition,
    };
  }

  function getInitState() {
    return {
      connected,
      callsign,
      comFrequencies: { ...currentComFrequencies },
      comStations: { ...currentComStations },
      xpdrState: { ...currentXpdrState },
      flightPlanStatus,
      flightPlan: { ...flightPlan },
      weatherState: getWeatherState(),
      stations: Array.from(knownStations.values()),
      ownPosition,
      log: messageLog.slice(-100),
    };
  }

  return {
    broadcast,
    getCallsign: () => callsign,
    getConnected: () => connected,
    getFlightPlan: () => ({ ...flightPlan }),
    getFlightPlanStatus: () => flightPlanStatus,
    getWeatherState,
    getStatus,
    getRadioState,
    getStationsState,
    getInitState,
    setConnected,
    setCallsign,
    updateComFrequency,
    updateXpdrState,
    updateFlightPlanStatus,
    updateWeather,
    roleForWeatherIcao,
    rememberFsdState,
    rememberStation,
  };
}

function createEmptyWeatherState(flightPlan) {
  return {
    departure: createWeatherSlot(flightPlan.departure),
    destination: createWeatherSlot(flightPlan.destination),
  };
}

function createWeatherSlot(icao) {
  return {
    icao: normalizeIcao(icao),
    metar: null,
    taf: null,
  };
}

function normalizeFlightPlan(next, fallback = {}) {
  return {
    departure: normalizeIcao(next?.departure) || normalizeIcao(fallback.departure),
    destination: normalizeIcao(next?.destination) || normalizeIcao(fallback.destination),
    alternate: normalizeIcao(next?.alternate) || normalizeIcao(fallback.alternate),
  };
}

function sameFlightPlan(a, b) {
  return normalizeIcao(a?.departure) === normalizeIcao(b?.departure)
    && normalizeIcao(a?.destination) === normalizeIcao(b?.destination)
    && normalizeIcao(a?.alternate) === normalizeIcao(b?.alternate);
}

function normalizeIcao(value) {
  const text = String(value || '').trim().toUpperCase();
  return /^[A-Z]{4}$/.test(text) ? text : '';
}

module.exports = {
  createAppState,
};
