const loginForm = document.getElementById('login-form');
const loginPasswordInput = document.getElementById('login-password');
const loginPanel = document.getElementById('login-panel');
const configPanel = document.getElementById('config-panel');
const configForm = document.getElementById('config-form');
const loginMessage = document.getElementById('login-message');
const saveMessage = document.getElementById('save-message');
const statusPill = document.getElementById('status-pill');
const toast = document.getElementById('toast');
const envPort = document.getElementById('env-port');
const reloadBtn = document.getElementById('reload-btn');
const logoutBtn = document.getElementById('logout-btn');
const resetBtn = document.getElementById('reset-btn');
const startBotBtn = document.getElementById('start-bot-btn');
const stopBotBtn = document.getElementById('stop-bot-btn');
const startBinaryBtn = document.getElementById('start-binary-btn');
const stopBinaryBtn = document.getElementById('stop-binary-btn');
const binaryStatusInput = document.getElementById('binary-status');

let cachedConfig = null;
let adminPassword = sessionStorage.getItem('adminPassword') || '';

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function setStatus(text, isOk = false) {
  statusPill.textContent = text;
  statusPill.classList.toggle('ok', isOk);
}

function togglePassword(input) {
  input.type = input.type === 'password' ? 'text' : 'password';
}

function setByPath(obj, path, value) {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!current[parts[i]]) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc ? acc[key] : undefined), obj);
}

function parseList(value) {
  if (!value) return [];
  return value
    .split(/\n|,/g)
    .map(item => item.trim())
    .filter(Boolean);
}

function stringifyList(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list.join('\n');
}

function collectFormData() {
  const payload = {};
  const fields = configForm.querySelectorAll('[data-key]');
  fields.forEach(field => {
    const key = field.getAttribute('data-key');
    const type = field.getAttribute('data-type');
    let value = field.type === 'checkbox' ? field.checked : field.value;

    if (type === 'number') {
      value = value === '' ? '' : Number(value);
    }
    if (type === 'list') {
      value = parseList(value);
    }

    setByPath(payload, key, value);
  });
  return payload;
}

function fillForm(data) {
  const fields = configForm.querySelectorAll('[data-key]');
  fields.forEach(field => {
    const key = field.getAttribute('data-key');
    const type = field.getAttribute('data-type');
    const value = getByPath(data, key);

    if (field.type === 'checkbox') {
      field.checked = Boolean(value);
    } else if (type === 'list') {
      field.value = stringifyList(value);
    } else if (value !== undefined && value !== null) {
      field.value = value;
    } else {
      field.value = '';
    }
  });
}

async function requestConfig() {
  const response = await fetch('/api/config', {
    headers: {
      'x-admin-password': adminPassword,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    throw data;
  }
  return data;
}

async function loadConfig(showToastMessage = true) {
  loginMessage.textContent = '';
  loginMessage.classList.remove('error');
  saveMessage.textContent = '';
  saveMessage.classList.remove('error');
  try {
    const payload = await requestConfig();
    cachedConfig = payload.data;
    fillForm(payload.data);
    loginPanel.classList.add('hidden');
    configPanel.classList.remove('hidden');
    setStatus('Signed in', true);
    await loadEnv();
    await refreshBotStatus();
    await refreshBinaryStatus();
    if (showToastMessage) showToast('Config loaded');
  } catch (error) {
    const message = error?.message || 'Login failed. Check your password.';
    loginMessage.textContent = message;
    loginMessage.classList.add('error');
    setStatus('Signed out', false);
    if (showToastMessage) showToast(message, true);
  }
}

async function loadEnv() {
  if (!envPort) return;
  try {
    const response = await fetch('/api/env', {
      headers: {
        'x-admin-password': adminPassword,
      },
    });
    const data = await response.json();
    if (!response.ok) {
      throw data;
    }
    envPort.textContent = data.data?.port ? String(data.data.port) : '-';
  } catch (error) {
    envPort.textContent = '-';
  }
}

async function refreshBotStatus() {
  try {
    const response = await fetch('/api/bot/status', {
      headers: {
        'x-admin-password': adminPassword,
      },
    });
    const data = await response.json();
    if (!response.ok) {
      throw data;
    }
    if (data.data?.running) {
      setStatus('Bot running', true);
    } else if (data.data?.starting) {
      setStatus('Bot starting', true);
    } else {
      setStatus('Bot stopped', false);
    }
  } catch (error) {
    setStatus('Status unknown', false);
  }
}

async function refreshBinaryStatus() {
  if (!binaryStatusInput) return;
  try {
    const response = await fetch('/api/binary/status', {
      headers: {
        'x-admin-password': adminPassword,
      },
    });
    const data = await response.json();
    if (!response.ok) {
      throw data;
    }
    if (data.data?.running) {
      binaryStatusInput.value = 'Running';
    } else {
      binaryStatusInput.value = 'Stopped';
    }
  } catch (error) {
    binaryStatusInput.value = 'Unknown';
  }
}

async function saveConfig(event) {
  event.preventDefault();
  saveMessage.textContent = '';
  saveMessage.classList.remove('error');
  const payload = collectFormData();

  if (payload.ADMIN_PASSWORD === '') {
    delete payload.ADMIN_PASSWORD;
  }

  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': adminPassword,
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw data;
    }
    cachedConfig = data.data;
    fillForm(data.data);
    showToast('Config saved. Restart service to apply.');
  } catch (error) {
    const message = error?.message || 'Save failed. Please retry.';
    saveMessage.textContent = message;
    saveMessage.classList.add('error');
    showToast(message, true);
  }
}

function handleLogout() {
  sessionStorage.removeItem('adminPassword');
  adminPassword = '';
  configPanel.classList.add('hidden');
  loginPanel.classList.remove('hidden');
  setStatus('Signed out', false);
}

async function handleStartBot() {
  if (!adminPassword) {
    showToast('Please log in first', true);
    return;
  }
  try {
    const response = await fetch('/api/bot/start', {
      method: 'POST',
      headers: {
        'x-admin-password': adminPassword,
      },
    });
    const data = await response.json();
    if (!response.ok) {
      throw data;
    }
    showToast('Bot started');
    await refreshBotStatus();
  } catch (error) {
    const message = error?.message || 'Start failed';
    showToast(message, true);
  }
}

async function handleStopBot() {
  if (!adminPassword) {
    showToast('Please log in first', true);
    return;
  }
  try {
    const response = await fetch('/api/bot/stop', {
      method: 'POST',
      headers: {
        'x-admin-password': adminPassword,
      },
    });
    const data = await response.json();
    if (!response.ok) {
      throw data;
    }
    showToast('Bot stopped');
    await refreshBotStatus();
  } catch (error) {
    const message = error?.message || 'Stop failed';
    showToast(message, true);
  }
}

async function handleStartBinary() {
  if (!adminPassword) {
    showToast('Please log in first', true);
    return;
  }
  const payload = collectFormData();
  try {
    const response = await fetch('/api/binary/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': adminPassword,
      },
      body: JSON.stringify({
        url: payload.BINARY_URL || '',
        port: Number.isFinite(payload.BINARY_PORT) ? payload.BINARY_PORT : undefined,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw data;
    }
    showToast('Binary started');
    await refreshBinaryStatus();
  } catch (error) {
    const message = error?.message || 'Start failed';
    showToast(message, true);
  }
}

async function handleStopBinary() {
  if (!adminPassword) {
    showToast('Please log in first', true);
    return;
  }
  try {
    const response = await fetch('/api/binary/stop', {
      method: 'POST',
      headers: {
        'x-admin-password': adminPassword,
      },
    });
    const data = await response.json();
    if (!response.ok) {
      throw data;
    }
    showToast('Binary stopped');
    await refreshBinaryStatus();
  } catch (error) {
    const message = error?.message || 'Stop failed';
    showToast(message, true);
  }
}

loginForm.addEventListener('submit', event => {
  event.preventDefault();
  loginMessage.textContent = '';
  loginMessage.classList.remove('error');
  adminPassword = loginPasswordInput.value.trim();
  if (!adminPassword) {
    loginMessage.textContent = 'Enter admin password';
    loginMessage.classList.add('error');
    return;
  }
  sessionStorage.setItem('adminPassword', adminPassword);
  loadConfig();
});

configForm.addEventListener('submit', saveConfig);
reloadBtn.addEventListener('click', () => loadConfig());
logoutBtn.addEventListener('click', handleLogout);
resetBtn.addEventListener('click', () => {
  if (cachedConfig) {
    fillForm(cachedConfig);
    showToast('Restored latest loaded config');
  }
});

startBotBtn.addEventListener('click', handleStartBot);
stopBotBtn.addEventListener('click', handleStopBot);
if (startBinaryBtn) startBinaryBtn.addEventListener('click', handleStartBinary);
if (stopBinaryBtn) stopBinaryBtn.addEventListener('click', handleStopBinary);

document.getElementById('toggle-login-password').addEventListener('click', () => {
  togglePassword(loginPasswordInput);
});

document.querySelectorAll('[data-toggle]').forEach(button => {
  button.addEventListener('click', () => {
    const key = button.getAttribute('data-toggle');
    const target = configForm.querySelector(`[data-key="${key}"]`);
    if (target) togglePassword(target);
  });
});

if (adminPassword) {
  loginPasswordInput.value = adminPassword;
  loadConfig(false);
}

setInterval(() => {
  if (adminPassword) {
    refreshBotStatus();
    refreshBinaryStatus();
  }
}, 5000);
