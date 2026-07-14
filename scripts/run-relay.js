'use strict';

// Load the optional relay .env without adding a dotenv dependency.
const path = require('path');
const { applyEnvFile } = require('./env-file');

const root = path.resolve(__dirname, '..');
const envFile = process.env.VOXHF_RELAY_ENV_FILE || path.join(root, 'apps', 'relay', '.env');
const loaded = applyEnvFile(envFile);

console.log('[relay] Env file: ' + (loaded ? envFile : 'not found, using process environment'));
require('../apps/relay');