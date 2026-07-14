'use strict';

const params = new URLSearchParams(location.search);
const list = document.getElementById('server-list');
const updated = document.getElementById('directory-updated');
const search = document.getElementById('server-search');
const access = document.getElementById('server-access');
const status = document.getElementById('server-status');
let servers = [];

initialize();

async function initialize() {
  bindFilters();
  if (params.get('demo') === '1') {
    servers = demoServers();
    updated.textContent = 'Demonstration directory data';
    render();
    return;
  }

  try {
    const response = await fetch('/directory/api/servers', { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || body.ok === false || !Array.isArray(body.servers)) throw new Error(body.error || 'Directory unavailable');
    servers = body.servers.map(normalizeServer).filter(Boolean);
    updated.textContent = body.generatedAt ? 'Directory updated ' + relativeTime(body.generatedAt) : '';
    render();
  } catch (_) {
    list.replaceChildren(emptyState('The server directory is currently unavailable. Try again later.'));
    updated.textContent = '';
  }
}

function bindFilters() {
  [search, access, status].forEach(control => control.addEventListener('input', render));
}

function render() {
  const query = search.value.trim().toLowerCase();
  const accessFilter = access.value;
  const statusFilter = status.value;
  const filtered = servers
    .filter(server => !query || [server.name, server.operator, server.region, server.description].some(value => value.toLowerCase().includes(query)))
    .filter(server => !accessFilter || server.access === accessFilter)
    .filter(server => !statusFilter || server.status === statusFilter)
    .sort((a, b) => Number(b.official) - Number(a.official) || statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name));

  list.replaceChildren();
  if (!filtered.length) {
    list.appendChild(emptyState('No listed server matches these filters.'));
    return;
  }
  filtered.forEach(server => list.appendChild(serverRow(server)));
}

function serverRow(server) {
  const row = document.createElement('article');
  row.className = 'server-row' + (server.official ? ' is-official' : '');

  const identity = document.createElement('div');
  identity.className = 'server-name';
  const name = document.createElement('strong');
  name.textContent = server.name;
  const title = document.createElement('div');
  title.className = 'server-title';
  const description = document.createElement('p');
  description.textContent = server.description || 'No description provided.';
  const kind = document.createElement('div');
  kind.className = 'server-kind';
  kind.textContent = server.official ? 'Official server' : 'Independent server';
  title.append(name, kind);
  identity.append(title, description);

  const links = document.createElement('div');
  links.className = 'server-links';
  addSafeLink(links, server.privacyUrl, 'Privacy');
  addSafeLink(links, server.sourceUrl, 'Declared source');

  const facts = document.createElement('div');
  facts.className = 'server-facts';
  facts.append(
    serverFact('Operator', server.operator || 'Not provided'),
    serverFact('Region', server.region || 'Not provided'),
    serverFact('Access', accessLabel(server.access)),
    serverFact('Resources', links.childElementCount ? links : 'Not provided'),
  );

  const stateCell = document.createElement('div');
  stateCell.className = 'server-status-cell';
  const state = document.createElement('span');
  state.className = 'server-state ' + server.status;
  state.textContent = statusLabel(server.status);
  state.title = server.lastSeenAt ? 'Last heartbeat ' + relativeTime(server.lastSeenAt) : 'No recent heartbeat';
  stateCell.appendChild(state);

  const appUrl = safeHttpsUrl(server.appUrl);
  if (appUrl && server.access !== 'closed') {
    const open = document.createElement('a');
    open.className = 'server-open';
    open.href = appUrl;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = server.access === 'invite' ? 'Open login' : 'Open server';
    stateCell.appendChild(open);
  }

  row.append(identity, stateCell, facts);
  return row;
}

function serverFact(label, value) {
  const fact = document.createElement('div');
  fact.className = 'server-fact';
  const heading = document.createElement('span');
  heading.className = 'server-fact-label';
  heading.textContent = label;
  fact.appendChild(heading);
  if (value instanceof Node) fact.appendChild(value);
  else {
    const text = document.createElement('span');
    text.className = 'server-meta';
    text.textContent = value;
    fact.appendChild(text);
  }
  return fact;
}

function addSafeLink(container, value, label) {
  const href = safeHttpsUrl(value);
  if (!href) return;
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label;
  container.appendChild(link);
}

function normalizeServer(value) {
  if (!value || typeof value !== 'object') return null;
  const name = compactText(value.name, 80);
  if (!name) return null;
  return {
    id: compactText(value.id, 80),
    name,
    operator: compactText(value.operator, 80),
    region: compactText(value.region, 48),
    description: compactText(value.description, 240),
    access: ['open', 'invite', 'closed'].includes(value.access) ? value.access : 'closed',
    status: ['online', 'maintenance', 'offline'].includes(value.status) ? value.status : 'offline',
    official: value.official === true,
    appUrl: safeHttpsUrl(value.appUrl),
    relayUrl: safeHttpsUrl(value.relayUrl),
    privacyUrl: safeHttpsUrl(value.privacyUrl),
    sourceUrl: safeHttpsUrl(value.sourceUrl),
    lastSeenAt: compactText(value.lastSeenAt, 40),
    version: compactText(value.version, 32),
  };
}

function compactText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

function accessLabel(value) {
  if (value === 'open') return 'Open registration';
  if (value === 'invite') return 'Invite only';
  return 'Closed';
}

function statusLabel(value) {
  if (value === 'online') return 'Online';
  if (value === 'maintenance') return 'Maintenance';
  return 'Offline';
}

function statusRank(value) {
  return value === 'online' ? 0 : value === 'maintenance' ? 1 : 2;
}

function relativeTime(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'recently';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + ' h ago';
  return Math.round(hours / 24) + ' d ago';
}

function emptyState(message) {
  const element = document.createElement('div');
  element.className = 'directory-empty';
  element.textContent = message;
  return element;
}

function demoServers() {
  const now = Date.now();
  return [
    {
      id: 'voxhf-official',
      name: 'VoxHF Community',
      operator: 'VoxHF project',
      region: 'Europe',
      description: 'Project-operated preview relay for invited beta participants.',
      access: 'invite',
      status: 'online',
      official: true,
      appUrl: 'https://app.voxhf.com',
      privacyUrl: 'https://voxhf.com/privacy.html',
      sourceUrl: 'https://github.com/leledeste/voxhf',
      lastSeenAt: new Date(now - 18000).toISOString(),
      version: '0.1.0',
    },
    {
      id: 'northstar',
      name: 'Northstar Relay',
      operator: 'Northstar Flight Group',
      region: 'EU West',
      description: 'Invite-only independent server for a small virtual flying group.',
      access: 'invite',
      status: 'online',
      official: false,
      appUrl: 'https://app.northstar.example',
      privacyUrl: 'https://northstar.example/privacy',
      sourceUrl: 'https://github.com/leledeste/voxhf',
      lastSeenAt: new Date(now - 42000).toISOString(),
      version: '0.1.0',
    },
    {
      id: 'openscope',
      name: 'OpenScope Community',
      operator: 'OpenScope',
      region: 'North America',
      description: 'Independent community relay currently undergoing maintenance.',
      access: 'closed',
      status: 'maintenance',
      official: false,
      appUrl: 'https://app.openscope.example',
      privacyUrl: 'https://openscope.example/privacy',
      sourceUrl: 'https://github.com/example/voxhf-fork',
      lastSeenAt: new Date(now - 240000).toISOString(),
      version: '0.1.0',
    },
  ].map(normalizeServer);
}
