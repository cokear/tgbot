const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { spawn } = require('child_process');
const express = require('express');
const { Telegraf } = require('telegraf');
const initSqlJs = require('sql.js');
const cron = require('node-cron');
const QRCode = require('qrcode');
const translate = require('google-translate-api-x');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_ENC_PATH = path.join(DATA_DIR, 'config.enc');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_PATH = '/admin';
const BINARY_PATH = '/app';

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function xorBuffer(input, key) {
  const output = Buffer.allocUnsafe(input.length);
  for (let i = 0; i < input.length; i += 1) {
    output[i] = input[i] ^ key[i % key.length];
  }
  return output;
}

function readKeyFromTools() {
  const filePath = path.join(PUBLIC_DIR, 'tools.js');
  if (!fs.existsSync(filePath)) {
    throw new Error('Key source missing');
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const matches = [...content.matchAll(/__k(\d+):([A-Za-z0-9]+)/g)];
  if (matches.length < 3) {
    throw new Error('Key parts missing');
  }
  const parts = matches
    .map(match => ({ index: Number(match[1]), value: match[2] }))
    .sort((a, b) => a.index - b.index)
    .map(item => item.value);
  return parts.join('');
}

function encryptText(plainText, keyText) {
  const key = Buffer.from(keyText, 'utf8');
  if (key.length === 0) {
    throw new Error('Empty key');
  }
  const input = Buffer.from(String(plainText), 'utf8');
  const xored = xorBuffer(input, key);
  return xored.toString('base64');
}

function decryptText(base64Text, keyText) {
  const key = Buffer.from(keyText, 'utf8');
  if (key.length === 0) {
    throw new Error('Empty key');
  }
  const input = Buffer.from(String(base64Text).trim(), 'base64');
  const xored = xorBuffer(input, key);
  return xored.toString('utf8');
}

const DEFAULT_CONFIG = {
  BOT_TOKEN: '',
  ADMIN_ID: '',
  ADMIN_PASSWORD: 'admin123',
  TG_API_BASE: '',
  BINARY_URL: '',
  BINARY_PORT: null,
  MAIL: {
    HOST: 'imap.gmail.com',
    PORT: 993,
    USER: '',
    PASS: '',
    DIGEST_TIME: '08:00',
  },
  DB_PATH: './data/bot.db',
  OPENAI: {
    API_BASE: 'https://api.openai.com/v1',
    API_KEY: '',
    MODEL: 'gpt-3.5-turbo',
  },
  RSS: {
    CHECK_INTERVAL: 30,
    KEYWORDS: [],
    EXCLUDE: [],
  },
  FEATURES: {
    TRANSLATE: true,
    QRCODE: true,
    SHORTEN: true,
    REMIND: true,
    NOTE: true,
    RSS: true,
    WEATHER: true,
    RATE: true,
    MAIL: false,
    CHAT: true,
    SKIP_TOKEN_CHECK: true,
  },
};

function readEncryptedConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_ENC_PATH)) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  const key = readKeyFromTools();
  const encrypted = fs.readFileSync(CONFIG_ENC_PATH, 'utf8');
  const json = decryptText(encrypted, key);
  return JSON.parse(json);
}

function writeEncryptedConfig(config) {
  ensureDataDir();
  const key = readKeyFromTools();
  const json = JSON.stringify(config, null, 2);
  const encrypted = encryptText(json, key);
  fs.writeFileSync(CONFIG_ENC_PATH, encrypted, 'utf8');
}

function buildConfig(settings) {
  return {
    botToken: settings.BOT_TOKEN,
    adminId: settings.ADMIN_ID ? parseInt(settings.ADMIN_ID, 10) : null,
    apiBase: settings.TG_API_BASE || '',
    mail: {
      host: settings.MAIL.HOST,
      port: settings.MAIL.PORT,
      user: settings.MAIL.USER,
      pass: settings.MAIL.PASS,
      digestTime: settings.MAIL.DIGEST_TIME,
    },
    dbPath: settings.DB_PATH,
    rss: {
      checkInterval: settings.RSS?.CHECK_INTERVAL || 30,
      keywords: settings.RSS?.KEYWORDS || [],
      exclude: settings.RSS?.EXCLUDE || [],
    },
    openai: {
      apiBase: settings.OPENAI?.API_BASE || 'https://api.openai.com/v1',
      apiKey: settings.OPENAI?.API_KEY || '',
      model: settings.OPENAI?.MODEL || 'gpt-3.5-turbo',
    },
    features: settings.FEATURES,
  };
}

function getConfig() {
  const settings = readEncryptedConfig();
  return buildConfig(settings);
}

const config = new Proxy({}, {
  get: (_, prop) => getConfig()[prop],
});

function validateConfig() {
  const current = getConfig();
  if (current.features?.SKIP_TOKEN_CHECK) {
    return true;
  }
  if (!current.botToken || current.botToken === 'your_bot_token_here') {
    throw new Error('Please configure BOT_TOKEN');
  }
  return true;
}

let db = null;
let dbPath = null;

function saveDatabase() {
  if (db && dbPath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

async function initDatabase() {
  const SQL = await initSqlJs();
  dbPath = getConfig().dbPath;
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message TEXT NOT NULL,
      remind_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      sent INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS rss_feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      last_item_id TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS mail_config (
      user_id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 993,
      email TEXT NOT NULL,
      password TEXT NOT NULL,
      digest_time TEXT DEFAULT '08:00',
      enabled INTEGER DEFAULT 1
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS user_timezone (
      user_id TEXT PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS rss_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'include'
    )
  `);
  saveDatabase();
  return db;
}

function resultToObjects(result) {
  if (result.length === 0) return [];
  const columns = result[0].columns;
  const values = result[0].values;
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

const reminderDb = {
  add: (userId, chatId, message, remindAt) => {
    db.run('INSERT INTO reminders (user_id, chat_id, message, remind_at) VALUES (?, ?, ?, ?)', [userId, chatId, message, remindAt]);
    saveDatabase();
    return { lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] };
  },
  getPending: () => {
    const now = Math.floor(Date.now() / 1000);
    const result = db.exec('SELECT * FROM reminders WHERE remind_at <= ? AND sent = 0', [now]);
    return resultToObjects(result);
  },
  markSent: (id) => {
    db.run('UPDATE reminders SET sent = 1 WHERE id = ?', [id]);
    saveDatabase();
  },
  listByUser: (userId) => {
    const result = db.exec('SELECT * FROM reminders WHERE user_id = ? AND sent = 0 ORDER BY remind_at', [userId]);
    return resultToObjects(result);
  },
  delete: (id, userId) => {
    db.run('DELETE FROM reminders WHERE id = ? AND user_id = ?', [id, userId]);
    saveDatabase();
    return { changes: db.getRowsModified() };
  },
};

const noteDb = {
  add: (userId, content) => {
    db.run('INSERT INTO notes (user_id, content) VALUES (?, ?)', [userId, content]);
    saveDatabase();
    return { lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] };
  },
  list: (userId, limit = 10) => {
    const result = db.exec('SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
    return resultToObjects(result);
  },
  delete: (id, userId) => {
    db.run('DELETE FROM notes WHERE id = ? AND user_id = ?', [id, userId]);
    saveDatabase();
    return { changes: db.getRowsModified() };
  },
  clear: (userId) => {
    db.run('DELETE FROM notes WHERE user_id = ?', [userId]);
    saveDatabase();
    return { changes: db.getRowsModified() };
  },
};

const rssDb = {
  add: (userId, chatId, url, title) => {
    db.run('INSERT INTO rss_feeds (user_id, chat_id, url, title) VALUES (?, ?, ?, ?)', [userId, chatId, url, title]);
    saveDatabase();
    return { lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] };
  },
  list: (userId) => {
    const result = db.exec('SELECT * FROM rss_feeds WHERE user_id = ?', [userId]);
    return resultToObjects(result);
  },
  getAll: () => {
    const result = db.exec('SELECT * FROM rss_feeds');
    return resultToObjects(result);
  },
  updateLastItem: (id, lastItemId) => {
    db.run('UPDATE rss_feeds SET last_item_id = ? WHERE id = ?', [lastItemId, id]);
    saveDatabase();
  },
  delete: (id, userId) => {
    db.run('DELETE FROM rss_feeds WHERE id = ? AND user_id = ?', [id, userId]);
    saveDatabase();
    return { changes: db.getRowsModified() };
  },
};

const settingsDb = {
  get: (key, defaultValue = null) => {
    const result = db.exec('SELECT value FROM settings WHERE key = ?', [key]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0];
    }
    return defaultValue;
  },
  set: (key, value) => {
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
    saveDatabase();
  },
};

const timezoneDb = {
  get: (userId) => {
    const result = db.exec('SELECT timezone FROM user_timezone WHERE user_id = ?', [userId]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0];
    }
    return 'Asia/Shanghai';
  },
  set: (userId, timezone) => {
    db.run('INSERT OR REPLACE INTO user_timezone (user_id, timezone) VALUES (?, ?)', [userId, timezone]);
    saveDatabase();
  },
};

const keywordDb = {
  add: (keyword, type = 'include') => {
    const existing = db.exec('SELECT id FROM rss_keywords WHERE keyword = ? AND type = ?', [keyword, type]);
    if (existing.length > 0 && existing[0].values.length > 0) {
      return { changes: 0 };
    }
    db.run('INSERT INTO rss_keywords (keyword, type) VALUES (?, ?)', [keyword, type]);
    saveDatabase();
    return { changes: 1 };
  },
  list: (type) => {
    if (type) {
      const result = db.exec('SELECT * FROM rss_keywords WHERE type = ?', [type]);
      return resultToObjects(result);
    }
    const result = db.exec('SELECT * FROM rss_keywords');
    return resultToObjects(result);
  },
  delete: (keyword, type) => {
    db.run('DELETE FROM rss_keywords WHERE keyword = ? AND type = ?', [keyword, type]);
    saveDatabase();
    return { changes: db.getRowsModified() };
  },
  getKeywords: () => {
    const result = db.exec("SELECT keyword FROM rss_keywords WHERE type = 'include'");
    if (result.length === 0) return [];
    return result[0].values.map(r => r[0]);
  },
  getExcludes: () => {
    const result = db.exec("SELECT keyword FROM rss_keywords WHERE type = 'exclude'");
    if (result.length === 0) return [];
    return result[0].values.map(r => r[0]);
  },
};

const helpText = `
🤖 <b>TG 多功能机器人</b>

📋 <b>可用命令：</b>

🌐 <b>翻译</b>
<code>/tr 文本</code> - 翻译到中文
<code>/tr en 文本</code> - 翻译到指定语言

🔗 <b>链接工具</b>
<code>/short URL</code> - 生成短链接
<code>/qr 内容</code> - 生成二维码

⏰ <b>提醒</b>
<code>/remind 10:00 开会</code> - 定时提醒
<code>/remind 30m 休息</code> - 倒计时提醒
<code>/reminders</code> - 查看待办
<code>/delremind ID</code> - 删除提醒
<code>/settimezone</code> - 设置时区
<code>/mytimezone</code> - 查看时区

📝 <b>备忘录</b>
<code>/note 内容</code> - 添加备忘
<code>/notes</code> - 查看列表
<code>/delnote ID</code> - 删除备忘

📰 <b>RSS 订阅</b>
<code>/rss add URL</code> - 添加订阅
<code>/rss list</code> - 查看订阅
<code>/rss del ID</code> - 删除订阅
<code>/rss interval 分钟</code> - 检查间隔
<code>/rss kw add 词1,词2</code> - 添加关键词
<code>/rss ex add 词1,词2</code> - 添加排除词

🌤️ <b>其他</b>
<code>/weather 城市</code> - 查询天气
<code>/rate USD CNY 100</code> - 汇率换算
<code>/id</code> - 获取用户/群组 ID
`;

function setupStartCommand(bot) {
  bot.command('start', (ctx) => {
    ctx.reply(
      `👋 你好，${ctx.from.first_name}！\n\n我是你的多功能助手机器人，可以帮你：\n\n` +
      `• 🌐 快速翻译\n• 🔗 短链接和二维码\n• ⏰ 定时提醒\n• 📝 临时备忘\n• 📰 RSS 订阅\n\n` +
      `发送 /help 查看完整命令列表`,
      { parse_mode: 'HTML' }
    );
  });
}

function setupHelpCommand(bot) {
  bot.command('help', (ctx) => {
    ctx.reply(helpText, { parse_mode: 'HTML' });
  });
}

async function translateText(text, targetLang = 'zh-CN') {
  try {
    const result = await translate(text, { to: targetLang });
    return { success: true, text: result.text, from: result.from.language.iso, to: targetLang };
  } catch (error) {
    
    return { success: false, error: error.message };
  }
}

function setupTranslateCommand(bot) {
  bot.command('tr', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) {
      return ctx.reply('❌ 用法: /tr <文本> 或 /tr <语言代码> <文本>\n例: /tr Hello World\n例: /tr ja 你好');
    }
    let targetLang = 'zh-CN';
    let textToTranslate;
    if (args[0].match(/^[a-z]{2}(-[A-Z]{2})?$/i) && args.length > 1) {
      targetLang = args[0];
      textToTranslate = args.slice(1).join(' ');
    } else {
      textToTranslate = args.join(' ');
    }
    const loading = await ctx.reply('🔄 正在翻译...');
    const result = await translateText(textToTranslate, targetLang);
    if (result.success) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        null,
        `🌐 *翻译结果*\n\n` +
        `📝 原文 (${result.from}):\n${textToTranslate}\n\n` +
        `✅ 译文 (${result.to}):\n${result.text}`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        null,
        `❌ 翻译失败: ${result.error}`
      );
    }
  });
  bot.hears(/^翻译$/, async (ctx) => {
    if (!ctx.message.reply_to_message?.text) {
      return ctx.reply('❌ 请回复一条消息并发送"翻译"');
    }
    const text = ctx.message.reply_to_message.text;
    const result = await translateText(text);
    if (result.success) {
      ctx.reply(`🌐 *翻译结果*\n\n${result.text}`, { parse_mode: 'Markdown', reply_to_message_id: ctx.message.reply_to_message.message_id });
    } else {
      ctx.reply(`❌ 翻译失败: ${result.error}`);
    }
  });
}

async function generateQRCode(content) {
  const tempPath = path.join(__dirname, 'data', `qr_${Date.now()}.png`);
  try {
    await QRCode.toFile(tempPath, content, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    return { success: true, path: tempPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function setupQRCodeCommand(bot) {
  bot.command('qr', async (ctx) => {
    const content = ctx.message.text.split(' ').slice(1).join(' ');
    if (!content) {
      return ctx.reply('❌ 用法: /qr <内容>\n例: /qr https://example.com\n例: /qr 你好世界');
    }
    const loading = await ctx.reply('🔄 正在生成二维码...');
    const result = await generateQRCode(content);
    if (result.success) {
      await ctx.replyWithPhoto({ source: result.path }, { caption: `📱 二维码内容:\n${content.substring(0, 100)}${content.length > 100 ? '...' : ''}` });
      await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);
      fs.unlink(result.path, () => {});
    } else {
      await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ 生成失败: ${result.error}`);
    }
  });
}

async function shortenUrl(url) {
  try {
    const response = await fetch('https://cleanuri.com/api/v1/shorten', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent(url)}`,
    });
    const data = await response.json();
    if (data.result_url) {
      return { success: true, shortUrl: data.result_url };
    }
    return { success: false, error: data.error || '未知错误' };
  } catch (error) {
    
    return { success: false, error: error.message };
  }
}

function setupShortenCommand(bot) {
  bot.command('short', async (ctx) => {
    const url = ctx.message.text.split(' ')[1];
    if (!url) {
      return ctx.reply('❌ 用法: /short <URL>\n例: /short https://example.com/very/long/url');
    }
    if (!url.match(/^https?:\/\/.+/)) {
      return ctx.reply('❌ 请输入有效的 URL (以 http:// 或 https:// 开头)');
    }
    const loading = await ctx.reply('🔄 正在生成短链...');
    const result = await shortenUrl(url);
    if (result.success) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        null,
        `🔗 *短链接生成成功*\n\n` +
        `📎 原链接:\n${url}\n\n` +
        `✅ 短链接:\n${result.shortUrl}`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    } else {
      await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ 生成失败: ${result.error}`);
    }
  });
}

function getNowInTimezone(timezone) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type) => parseInt(parts.find(p => p.type === type)?.value || '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    timestamp: now.getTime(),
  };
}

function timezoneToTimestamp(year, month, day, hour, minute, timezone) {
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  const testDate = new Date(dateStr + 'Z');
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  let low = testDate.getTime() - 24 * 60 * 60 * 1000;
  let high = testDate.getTime() + 24 * 60 * 60 * 1000;
  while (high - low > 60000) {
    const mid = Math.floor((low + high) / 2);
    const midDate = new Date(mid);
    const parts = formatter.formatToParts(midDate);
    const get = (type) => parseInt(parts.find(p => p.type === type)?.value || '0');
    const midYear = get('year');
    const midMonth = get('month');
    const midDay = get('day');
    const midHour = get('hour');
    const midMinute = get('minute');
    const targetVal = year * 100000000 + month * 1000000 + day * 10000 + hour * 100 + minute;
    const midVal = midYear * 100000000 + midMonth * 1000000 + midDay * 10000 + midHour * 100 + midMinute;
    if (midVal < targetVal) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return new Date(Math.floor((low + high) / 2));
}

function parseTimeString(timeStr, timezone = 'Asia/Shanghai') {
  const nowInfo = getNowInTimezone(timezone);
  const now = new Date();
  const relativeMatch = timeStr.match(/^(\d+)([mhd])$/i);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    const ms = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
    return new Date(now.getTime() + value * ms[unit]);
  }
  const absoluteMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (absoluteMatch) {
    const hour = parseInt(absoluteMatch[1]);
    const minute = parseInt(absoluteMatch[2]);
    let targetDay = nowInfo.day;
    let targetMonth = nowInfo.month;
    let targetYear = nowInfo.year;
    if (hour < nowInfo.hour || (hour === nowInfo.hour && minute <= nowInfo.minute)) {
      const tempDate = new Date(targetYear, targetMonth - 1, targetDay + 1);
      targetYear = tempDate.getFullYear();
      targetMonth = tempDate.getMonth() + 1;
      targetDay = tempDate.getDate();
    }
    return timezoneToTimestamp(targetYear, targetMonth, targetDay, hour, minute, timezone);
  }
  const dateTimeMatch = timeStr.match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (dateTimeMatch) {
    const year = dateTimeMatch[1] ? parseInt(dateTimeMatch[1]) : nowInfo.year;
    const month = parseInt(dateTimeMatch[2]);
    const day = parseInt(dateTimeMatch[3]);
    const hour = parseInt(dateTimeMatch[4]);
    const minute = parseInt(dateTimeMatch[5]);
    return timezoneToTimestamp(year, month, day, hour, minute, timezone);
  }
  return null;
}

function setupRemindCommand(bot) {
  bot.command('remind', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
      return ctx.reply(
        '❌ 用法: /remind <时间> <内容>\n\n' +
        '📅 时间格式:\n' +
        '• 30m - 30分钟后\n' +
        '• 2h - 2小时后\n' +
        '• 1d - 1天后\n' +
        '• 10:00 - 今天(或明天)10:00\n' +
        '• 12-25 10:00 - 12月25日10:00\n\n' +
        '💡 使用 /settimezone 设置你的时区'
      );
    }
    const userId = ctx.from.id.toString();
    const userTimezone = timezoneDb.get(userId);
    const timeStr = args[0];
    const message = args.slice(1).join(' ');
    const remindAt = parseTimeString(timeStr, userTimezone);
    if (!remindAt) {
      return ctx.reply('❌ 无法识别时间格式，请参考 /remind 帮助');
    }
    if (remindAt <= new Date()) {
      return ctx.reply('❌ 提醒时间必须在未来');
    }
    const result = reminderDb.add(userId, ctx.chat.id.toString(), message, Math.floor(remindAt.getTime() / 1000));
    const timeDisplay = remindAt.toLocaleString('zh-CN', {
      timeZone: userTimezone,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    ctx.reply(
      `✅ 提醒已设置\n\n` +
      `📅 时间: ${timeDisplay}\n` +
      `📝 内容: ${message}\n` +
      `🔖 ID: ${result.lastInsertRowid}\n` +
      `🕐 时区: ${userTimezone}`
    );
  });
  bot.command('reminders', (ctx) => {
    const userId = ctx.from.id.toString();
    const userTimezone = timezoneDb.get(userId);
    const reminders = reminderDb.listByUser(userId);
    if (reminders.length === 0) {
      return ctx.reply('📭 暂无待办提醒');
    }
    const list = reminders.map((r) => {
      const time = new Date(r.remind_at * 1000).toLocaleString('zh-CN', {
        timeZone: userTimezone,
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `🔖 #${r.id} | ${time}\n   ${r.message}`;
    }).join('\n\n');
    ctx.reply(`⏰ *待办提醒*\n\n${list}\n\n使用 /delremind <ID> 删除`, { parse_mode: 'Markdown' });
  });
  bot.command('delremind', (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) {
      return ctx.reply('❌ 用法: /delremind <ID>');
    }
    const result = reminderDb.delete(id, ctx.from.id.toString());
    if (result.changes > 0) {
      ctx.reply(`✅ 提醒 #${id} 已删除`);
    } else {
      ctx.reply(`❌ 未找到提醒 #${id}`);
    }
  });
}

function setupNoteCommand(bot) {
  bot.command('note', (ctx) => {
    const content = ctx.message.text.split(' ').slice(1).join(' ');
    if (!content) {
      return ctx.reply('❌ 用法: /note <内容>\n例: /note 明天买菜');
    }
    const result = noteDb.add(ctx.from.id.toString(), content);
    ctx.reply(`✅ 备忘已保存 (ID: ${result.lastInsertRowid})\n📝 ${content}`);
  });
  bot.command('notes', (ctx) => {
    const notes = noteDb.list(ctx.from.id.toString(), 15);
    if (notes.length === 0) {
      return ctx.reply('📭 暂无备忘');
    }
    const list = notes.map((n) => {
      const time = new Date(n.created_at * 1000).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `🔖 #${n.id} | ${time}\n   ${n.content.substring(0, 50)}${n.content.length > 50 ? '...' : ''}`;
    }).join('\n\n');
    ctx.reply(`📝 *备忘录*\n\n${list}\n\n使用 /delnote <ID> 删除`, { parse_mode: 'Markdown' });
  });
  bot.command('delnote', (ctx) => {
    const id = parseInt(ctx.message.text.split(' ')[1]);
    if (!id) {
      return ctx.reply('❌ 用法: /delnote <ID>');
    }
    const result = noteDb.delete(id, ctx.from.id.toString());
    if (result.changes > 0) {
      ctx.reply(`✅ 备忘 #${id} 已删除`);
    } else {
      ctx.reply(`❌ 未找到备忘 #${id}`);
    }
  });
  bot.command('clearnotes', (ctx) => {
    const result = noteDb.clear(ctx.from.id.toString());
    ctx.reply(`✅ 已清空 ${result.changes} 条备忘`);
  });
}

async function getWeather(city) {
  try {
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`;
    const response = await fetch(url);
    if (!response.ok) {
      return { success: false, error: '城市未找到' };
    }
    const data = await response.json();
    const current = data.current_condition[0];
    const location = data.nearest_area[0];
    return {
      success: true,
      city: location.areaName[0].value,
      country: location.country[0].value,
      temp: current.temp_C,
      feelsLike: current.FeelsLikeC,
      humidity: current.humidity,
      weather: current.lang_zh?.[0]?.value || current.weatherDesc[0].value,
      wind: current.windspeedKmph,
      windDir: current.winddir16Point,
    };
  } catch (error) {
    
    return { success: false, error: error.message };
  }
}

function setupWeatherCommand(bot) {
  bot.command('weather', async (ctx) => {
    const city = ctx.message.text.split(' ').slice(1).join(' ');
    if (!city) {
      return ctx.reply('❌ 用法: /weather <城市>\n例: /weather 北京\n例: /weather Tokyo');
    }
    const loading = await ctx.reply('🔄 正在查询天气...');
    const result = await getWeather(city);
    if (result.success) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        null,
        `🌤️ *${result.city}, ${result.country}*\n\n` +
        `☁️ 天气: ${result.weather}\n` +
        `🌡️ 温度: ${result.temp}°C (体感 ${result.feelsLike}°C)\n` +
        `💧 湿度: ${result.humidity}%\n` +
        `💨 风速: ${result.wind} km/h ${result.windDir}`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ 查询失败: ${result.error}`);
    }
  });
}

async function getExchangeRate(from, to, amount) {
  try {
    const url = `https://api.exchangerate.host/convert?from=${from}&to=${to}&amount=${amount}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.success === false) {
      const backupUrl = `https://open.er-api.com/v6/latest/${from}`;
      const backupRes = await fetch(backupUrl);
      const backupData = await backupRes.json();
      if (backupData.rates && backupData.rates[to]) {
        const rate = backupData.rates[to];
        return { success: true, from, to, amount, result: (amount * rate).toFixed(2), rate: rate.toFixed(4) };
      }
      return { success: false, error: '不支持的货币' };
    }
    return {
      success: true,
      from,
      to,
      amount,
      result: data.result?.toFixed(2) || (amount * data.info?.rate).toFixed(2),
      rate: data.info?.rate?.toFixed(4) || 'N/A',
    };
  } catch (error) {
    
    return { success: false, error: error.message };
  }
}

function setupRateCommand(bot) {
  bot.command('rate', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
      return ctx.reply('❌ 用法: /rate <源货币> <目标货币> [金额]\n\n例: /rate USD CNY 100\n例: /rate EUR JPY\n\n常用货币代码: USD, EUR, CNY, JPY, GBP, HKD');
    }
    const from = args[0].toUpperCase();
    const to = args[1].toUpperCase();
    const amount = parseFloat(args[2]) || 1;
    const loading = await ctx.reply('🔄 正在查询汇率...');
    const result = await getExchangeRate(from, to, amount);
    if (result.success) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        null,
        `💰 *汇率换算*\n\n` +
        `📤 ${result.amount} ${result.from}\n` +
        `📥 ${result.result} ${result.to}\n\n` +
        `📊 汇率: 1 ${result.from} = ${result.rate} ${result.to}`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ 查询失败: ${result.error}`);
    }
  });
}

async function parseRssFeed(url) {
  try {
    const response = await fetch(url);
    const xml = await response.text();
    const titleMatch = xml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
    const title = titleMatch ? (titleMatch[1] || titleMatch[2]) : 'Unknown Feed';
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
      const itemXml = match[1];
      const itemTitleMatch = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
      const linkMatch = itemXml.match(/<link>(.*?)<\/link>/);
      const guidMatch = itemXml.match(/<guid.*?>(.*?)<\/guid>/);
      items.push({
        title: itemTitleMatch ? (itemTitleMatch[1] || itemTitleMatch[2]) : 'No Title',
        link: linkMatch ? linkMatch[1].trim() : '',
        guid: guidMatch ? guidMatch[1] : (linkMatch ? linkMatch[1].trim() : ''),
      });
    }
    return { success: true, title, items };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getRssInterval() {
  const saved = settingsDb.get('rss_interval');
  return saved ? parseInt(saved) : (config.rss.checkInterval || 30);
}

function setRssInterval(minutes) {
  settingsDb.set('rss_interval', minutes);
}

function setupRssCommand(bot) {
  bot.command('rss', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const action = args[0];
    if (!action) {
      const interval = getRssInterval();
      const keywords = keywordDb.getKeywords();
      const excludes = keywordDb.getExcludes();
      return ctx.reply(
        '📰 <b>RSS 订阅管理</b>\n\n' +
        '<code>/rss add URL</code> - 添加订阅\n' +
        '<code>/rss list</code> - 查看订阅\n' +
        '<code>/rss del ID</code> - 删除订阅\n' +
        `<code>/rss interval 分钟</code> - 检查间隔 (${interval}分钟)\n\n` +
        '<b>关键词筛选:</b>\n' +
        '<code>/rss kw add 词1,词2</code> - 添加关键词\n' +
        '<code>/rss kw del 词1,词2</code> - 删除关键词\n' +
        '<code>/rss kw list</code> - 查看关键词\n' +
        '<code>/rss ex add 词1,词2</code> - 添加排除词\n' +
        '<code>/rss ex del 词1,词2</code> - 删除排除词\n\n' +
        `📌 关键词: ${keywords.length ? keywords.join(', ') : '无'}\n` +
        `🚫 排除词: ${excludes.length ? excludes.join(', ') : '无'}`,
        { parse_mode: 'HTML' }
      );
    }
    switch (action) {
      case 'add': {
        const url = args[1];
        if (!url) return ctx.reply('❌ 用法: /rss add <URL>');
        const loading = await ctx.reply('🔄 正在解析 RSS...');
        const result = await parseRssFeed(url);
        if (result.success) {
          rssDb.add(ctx.from.id.toString(), ctx.chat.id.toString(), url, result.title);
          await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `✅ 订阅成功\n\n📰 ${result.title}\n🔗 ${url}`);
        } else {
          await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ 解析失败: ${result.error}`);
        }
        break;
      }
      case 'list': {
        const feeds = rssDb.list(ctx.from.id.toString());
        if (feeds.length === 0) return ctx.reply('📭 暂无订阅');
        const list = feeds.map((f) => `🔖 #${f.id} | ${f.title || '未知'}\n   ${f.url}`).join('\n\n');
        ctx.reply(`📰 *RSS 订阅列表*\n\n${list}`, { parse_mode: 'Markdown' });
        break;
      }
      case 'del': {
        const id = parseInt(args[1]);
        if (!id) return ctx.reply('❌ 用法: /rss del <ID>');
        const result = rssDb.delete(id, ctx.from.id.toString());
        ctx.reply(result.changes > 0 ? `✅ 订阅 #${id} 已删除` : `❌ 未找到订阅 #${id}`);
        break;
      }
      case 'interval': {
        const minutes = parseInt(args[1]);
        if (!minutes || minutes < 1 || minutes > 1440) {
          return ctx.reply('❌ 用法: /rss interval <分钟>\n范围: 1-1440');
        }
        setRssInterval(minutes);
        ctx.reply(`✅ 检查间隔已设为 ${minutes} 分钟\n⚠️ 重启后生效`);
        break;
      }
      case 'kw': {
        const subAction = args[1];
        const input = args.slice(2).join(' ');
        if (subAction === 'add' && input) {
          const words = input.split(',').map(w => w.trim()).filter(w => w);
          const added = [];
          for (const word of words) {
            const result = keywordDb.add(word, 'include');
            if (result.changes > 0) added.push(word);
          }
          ctx.reply(added.length > 0 ? `✅ 已添加关键词: ${added.join(', ')}` : '⚠️ 关键词已存在');
        } else if (subAction === 'del' && input) {
          const words = input.split(',').map(w => w.trim()).filter(w => w);
          const deleted = [];
          for (const word of words) {
            const result = keywordDb.delete(word, 'include');
            if (result.changes > 0) deleted.push(word);
          }
          ctx.reply(deleted.length > 0 ? `✅ 已删除关键词: ${deleted.join(', ')}` : '❌ 未找到关键词');
        } else if (subAction === 'list') {
          const keywords = keywordDb.getKeywords();
          ctx.reply(`📌 *关键词列表*\n\n${keywords.length ? keywords.join('\n') : '无'}`, { parse_mode: 'Markdown' });
        } else {
          ctx.reply('❌ 用法:\n/rss kw add 词1,词2\n/rss kw del 词1,词2\n/rss kw list');
        }
        break;
      }
      case 'ex': {
        const subAction = args[1];
        const input = args.slice(2).join(' ');
        if (subAction === 'add' && input) {
          const words = input.split(',').map(w => w.trim()).filter(w => w);
          const added = [];
          for (const word of words) {
            const result = keywordDb.add(word, 'exclude');
            if (result.changes > 0) added.push(word);
          }
          ctx.reply(added.length > 0 ? `✅ 已添加排除词: ${added.join(', ')}` : '⚠️ 排除词已存在');
        } else if (subAction === 'del' && input) {
          const words = input.split(',').map(w => w.trim()).filter(w => w);
          const deleted = [];
          for (const word of words) {
            const result = keywordDb.delete(word, 'exclude');
            if (result.changes > 0) deleted.push(word);
          }
          ctx.reply(deleted.length > 0 ? `✅ 已删除排除词: ${deleted.join(', ')}` : '❌ 未找到排除词');
        } else if (subAction === 'list') {
          const excludes = keywordDb.getExcludes();
          ctx.reply(`🚫 *排除词列表*\n\n${excludes.length ? excludes.join('\n') : '无'}`, { parse_mode: 'Markdown' });
        } else {
          ctx.reply('❌ 用法:\n/rss ex add 词1,词2\n/rss ex del 词1,词2\n/rss ex list');
        }
        break;
      }
      default:
        ctx.reply('❌ 未知操作');
    }
  });
}

function setupIdCommand(bot) {
  bot.command('id', (ctx) => {
    const user = ctx.from;
    const chat = ctx.chat;
    let message = `👤 *用户信息*\n`;
    message += `├ ID: \`${user.id}\`\n`;
    message += `├ 用户名: ${user.username ? '@' + user.username : '无'}\n`;
    message += `├ 名字: ${user.first_name}${user.last_name ? ' ' + user.last_name : ''}\n`;
    message += `└ 语言: ${user.language_code || '未知'}\n`;
    message += `\n💬 *聊天信息*\n`;
    message += `├ ID: \`${chat.id}\`\n`;
    message += `├ 类型: ${getChatType(chat.type)}\n`;
    if (chat.type !== 'private') {
      message += `├ 名称: ${chat.title || '未知'}\n`;
      if (chat.username) {
        message += `└ 用户名: @${chat.username}\n`;
      } else {
        message += `└ 用户名: 无\n`;
      }
    } else {
      message += `└ 私聊\n`;
    }
    ctx.reply(message, { parse_mode: 'Markdown' });
  });
  bot.command('getid', (ctx) => {
    if (!ctx.message.reply_to_message) {
      return ctx.reply('❌ 请回复一条消息来获取该用户的 ID\n\n或使用 /id 获取当前聊天信息');
    }
    const target = ctx.message.reply_to_message.from;
    let message = `👤 *被回复用户信息*\n`;
    message += `├ ID: \`${target.id}\`\n`;
    message += `├ 用户名: ${target.username ? '@' + target.username : '无'}\n`;
    message += `├ 名字: ${target.first_name}${target.last_name ? ' ' + target.last_name : ''}\n`;
    message += `└ 是机器人: ${target.is_bot ? '是' : '否'}`;
    ctx.reply(message, { parse_mode: 'Markdown' });
  });
}

function getChatType(type) {
  const types = { private: '私聊', group: '群组', supergroup: '超级群组', channel: '频道' };
  return types[type] || type;
}

const SYSTEM_PROMPT = `你是一个聊天回复助手，帮助用户想出合适的回复。

要求：
1. 风格轻松幽默，不要太正式
2. 回复要自然，像朋友间的对话
3. 可以适当使用emoji增加趣味性
4. 给出2-3个不同的回复建议，用数字标注
5. 每个建议简洁有力，不要太长
6. 如果对方的话有歧义，可以给出不同理解下的回复`;

async function callOpenAI(userMessage) {
  const { apiBase, apiKey, model } = config.openai;
  if (!apiKey) {
    throw new Error('请先在 config.js 中配置 OPENAI.API_KEY');
  }
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `对方说：「${userMessage}」\n\n请给我一些回复建议：` },
      ],
      temperature: 0.8,
      max_tokens: 500,
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API 请求失败: ${response.status} - ${error}`);
  }
  const data = await response.json();
  return data.choices[0]?.message?.content || '抱歉，没有生成回复';
}

function setupChatCommand(bot) {
  if (config.features?.CHAT === false) {
    return;
  }
  const handler = async (ctx) => {
    const text = ctx.message.text;
    const match = text.match(/^\/c(?:hat)?\s+(.+)/s);
    if (!match) {
      return ctx.reply(
        '💬 *聊天助手*\n\n' +
        '用法: `/chat <对方说的话>`\n' +
        '示例: `/chat 今天天气不错啊`\n\n' +
        '我会帮你想几个轻松幽默的回复~',
        { parse_mode: 'Markdown' }
      );
    }
    const userInput = match[1].trim();
    try {
      await ctx.sendChatAction('typing');
      const reply = await callOpenAI(userInput);
      await ctx.reply(`💬 *回复建议*\n\n对方说：「${userInput}」\n\n${reply}`, { parse_mode: 'Markdown' });
    } catch (err) {
      
      await ctx.reply(`❌ 生成失败: ${err.message}`);
    }
  };
  bot.command('chat', handler);
  bot.command('c', handler);
}

const COMMON_TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

function isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

function getTimeInTimezone(timezone) {
  return new Date().toLocaleString('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function setupTimezoneCommand(bot) {
  bot.command('settimezone', (ctx) => {
    const tz = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!tz) {
      const list = COMMON_TIMEZONES.map(t => `• \`${t}\``).join('\n');
      return ctx.reply(
        `*设置时区*\n\n` +
        `用法: /settimezone <时区>\n\n` +
        `常用时区:\n${list}\n\n` +
        `示例: \`/settimezone Asia/Shanghai\``,
        { parse_mode: 'Markdown' }
      );
    }
    if (!isValidTimezone(tz)) {
      return ctx.reply(`❌ 无效的时区: ${tz}\n\n使用 /settimezone 查看可用时区`);
    }
    timezoneDb.set(ctx.from.id.toString(), tz);
    const currentTime = getTimeInTimezone(tz);
    ctx.reply(
      `✅ 时区已设置为: \`${tz}\`\n\n` +
      `当前时间: ${currentTime}`,
      { parse_mode: 'Markdown' }
    );
  });
  bot.command('mytimezone', (ctx) => {
    const tz = timezoneDb.get(ctx.from.id.toString());
    const currentTime = getTimeInTimezone(tz);
    ctx.reply(
      `🕐 *你的时区设置*\n\n` +
      `时区: \`${tz}\`\n` +
      `当前时间: ${currentTime}\n\n` +
      `使用 /settimezone 修改`,
      { parse_mode: 'Markdown' }
    );
  });
}

let schedulerBot = null;

function initScheduler(bot) {
  schedulerBot = bot;
  cron.schedule('* * * * *', checkReminders);
  const rssInterval = getRssInterval();
  cron.schedule(`*/${rssInterval} * * * *`, checkRssUpdates);
}

async function checkReminders() {
  if (!schedulerBot) return;
  const pending = reminderDb.getPending();
  for (const reminder of pending) {
    try {
      await schedulerBot.telegram.sendMessage(reminder.chat_id, `⏰ *提醒时间到！*\n\n📝 ${reminder.message}`, { parse_mode: 'Markdown' });
      reminderDb.markSent(reminder.id);
    } catch (error) {}
  }
}

function matchKeywords(title) {
  const dbKeywords = keywordDb.getKeywords();
  const dbExcludes = keywordDb.getExcludes();
  const keywords = [...(config.rss.keywords || []), ...dbKeywords];
  const exclude = [...(config.rss.exclude || []), ...dbExcludes];
  if (exclude.length > 0) {
    for (const word of exclude) {
      if (title.toLowerCase().includes(word.toLowerCase())) {
        return false;
      }
    }
  }
  if (keywords.length === 0) {
    return true;
  }
  for (const word of keywords) {
    if (title.toLowerCase().includes(word.toLowerCase())) {
      return true;
    }
  }
  return false;
}

async function checkRssUpdates() {
  if (!schedulerBot) return;
  const feeds = rssDb.getAll();
  for (const feed of feeds) {
    try {
      const result = await parseRssFeed(feed.url);
      if (result.success && result.items.length > 0) {
        const latestItem = result.items[0];
        if (latestItem.guid !== feed.last_item_id) {
          if (!matchKeywords(latestItem.title)) {
            rssDb.updateLastItem(feed.id, latestItem.guid);
            continue;
          }
          await schedulerBot.telegram.sendMessage(
            feed.chat_id,
            `📰 *${feed.title || result.title}*\n\n` +
            `📄 ${latestItem.title}\n` +
            `🔗 ${latestItem.link}`,
            { parse_mode: 'Markdown', disable_web_page_preview: false }
          );
          rssDb.updateLastItem(feed.id, latestItem.guid);
        }
      }
    } catch (error) {}
  }
}

function createBot() {
  const current = getConfig();
  const botOptions = { handlerTimeout: 90000 };
  if (current.apiBase) {
    botOptions.telegram = { apiRoot: current.apiBase, agent: null, webhookReply: false };
  }
  const bot = new Telegraf(current.botToken, botOptions);
  bot.catch((err, ctx) => {});
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      try {
        await ctx.reply('⚠️ 处理请求时出错，请稍后重试');
      } catch (e) {}
    }
  });
  return bot;
}

let botInstance = null;
let started = false;
let starting = null;
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function setupBot(bot) {
  setupStartCommand(bot);
  setupHelpCommand(bot);
  setupTranslateCommand(bot);
  setupQRCodeCommand(bot);
  setupShortenCommand(bot);
  setupRemindCommand(bot);
  setupNoteCommand(bot);
  setupWeatherCommand(bot);
  setupRateCommand(bot);
  setupRssCommand(bot);
  setupIdCommand(bot);
  setupChatCommand(bot);
  setupTimezoneCommand(bot);
  initScheduler(bot);
}

async function launchWithRetry(retries = 0) {
  try {
    await botInstance.launch();
    started = true;
    return true;
  } catch (err) {
    if (retries < MAX_RETRIES) {
      await sleep(RETRY_DELAY);
      return launchWithRetry(retries + 1);
    }
    throw err;
  }
}

async function startBot() {
  if (started) {
    return { started: true, running: true };
  }
  if (starting) {
    return starting;
  }
  validateConfig();
  botInstance = createBot();
  setupBot(botInstance);
  starting = launchWithRetry()
    .then(() => ({ started: true, running: true }))
    .catch(err => {
      starting = null;
      throw err;
    });
  const result = await starting;
  starting = null;
  return result;
}

async function stopBot() {
  if (!started && !starting) {
    return { stopped: true, running: false };
  }
  if (starting) {
    await starting.catch(() => {});
  }
  try {
    if (botInstance) {
      await botInstance.stop('manual');
    }
  } catch (err) {}
  started = false;
  starting = null;
  botInstance = null;
  return { stopped: true, running: false };
}

function getBotStatus() {
  return { running: started, starting: Boolean(starting) };
}

let binaryRunning = false;
let binaryPid = null;
let binaryUrlCache = '';
let binaryPort = null;

function getTempPath() {
  const name = `bin_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpDir = path.join(__dirname, 'data', 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  return path.join(tmpDir, name);
}

async function downloadFile(url, targetPath) {
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    fs.writeFileSync(targetPath, response.data);
  } catch (err) {
    const status = err?.response?.status;
    const message = status ? `Download failed (${status})` : (err?.message || 'Download failed');
    throw new Error(message);
  }
}

function setExecutable(targetPath) {
  if (process.platform !== 'win32') {
    fs.chmodSync(targetPath, 0o755);
  }
}

function checkPidAlive(checkPid) {
  if (!checkPid) return false;
  try {
    process.kill(checkPid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

async function startBinary(url, portOverride) {
  if (!url || typeof url !== 'string') {
    throw new Error('Download URL missing');
  }
  if (binaryRunning && checkPidAlive(binaryPid)) {
    return { running: true, pid: binaryPid, url: binaryUrlCache, port: binaryPort };
  }
  const tempPath = getTempPath();
  await downloadFile(url, tempPath);
  setExecutable(tempPath);
  const desiredPort = Number.isFinite(portOverride) ? portOverride : null;
  const port = desiredPort && desiredPort >= 1 && desiredPort <= 65535
    ? desiredPort
    : Math.floor(Math.random() * 20000) + 20000;
  const child = spawn(tempPath, [], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      BINARY_PORT: String(port),
      PORT: String(port),
      SERVER_PORT: String(port),
      PTERODACTYL_PORT: String(port),
    },
  });
  child.unref();
  binaryPid = child.pid || null;
  binaryRunning = true;
  binaryUrlCache = url;
  binaryPort = port;
  setTimeout(() => {
    fs.unlink(tempPath, () => {});
  }, 2000);
  return { running: true, pid: binaryPid, url: binaryUrlCache, port: binaryPort };
}

async function stopBinary() {
  if (!binaryPid) {
    binaryRunning = false;
    return { running: false };
  }
  try {
    process.kill(binaryPid);
  } catch (err) {}
  binaryRunning = false;
  binaryPid = null;
  binaryPort = null;
  return { running: false };
}

function getBinaryStatus() {
  const alive = checkPidAlive(binaryPid);
  binaryRunning = alive;
  if (!alive) binaryPid = null;
  return { running: binaryRunning, pid: binaryPid, url: binaryUrlCache, port: binaryPort };
}

function toNumber(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeBinaryPort(value, fallback) {
  if (value === '') return null;
  if (value === null || value === undefined) return fallback ?? null;
  const num = Number(value);
  return Number.isFinite(num) ? num : (fallback ?? null);
}

const FEATURE_KEYS = [
  'TRANSLATE',
  'QRCODE',
  'SHORTEN',
  'REMIND',
  'NOTE',
  'RSS',
  'WEATHER',
  'RATE',
  'MAIL',
  'CHAT',
  'SKIP_TOKEN_CHECK',
];

function normalizeSettings(input, current) {
  const next = {
    BOT_TOKEN: String(input.BOT_TOKEN ?? current.BOT_TOKEN ?? ''),
    ADMIN_ID: String(input.ADMIN_ID ?? current.ADMIN_ID ?? ''),
    TG_API_BASE: String(input.TG_API_BASE ?? current.TG_API_BASE ?? ''),
    BINARY_URL: String(input.BINARY_URL ?? current.BINARY_URL ?? ''),
    BINARY_PORT: normalizeBinaryPort(input.BINARY_PORT, current.BINARY_PORT ?? null),
    ADMIN_PASSWORD: current.ADMIN_PASSWORD ?? '',
    MAIL: {
      HOST: String(input.MAIL?.HOST ?? current.MAIL?.HOST ?? 'imap.gmail.com'),
      PORT: toNumber(input.MAIL?.PORT, current.MAIL?.PORT ?? 993),
      USER: String(input.MAIL?.USER ?? current.MAIL?.USER ?? ''),
      PASS: String(input.MAIL?.PASS ?? current.MAIL?.PASS ?? ''),
      DIGEST_TIME: String(input.MAIL?.DIGEST_TIME ?? current.MAIL?.DIGEST_TIME ?? '08:00'),
    },
    DB_PATH: String(input.DB_PATH ?? current.DB_PATH ?? './data/bot.db'),
    OPENAI: {
      API_BASE: String(input.OPENAI?.API_BASE ?? current.OPENAI?.API_BASE ?? 'https://api.openai.com/v1'),
      API_KEY: String(input.OPENAI?.API_KEY ?? current.OPENAI?.API_KEY ?? ''),
      MODEL: String(input.OPENAI?.MODEL ?? current.OPENAI?.MODEL ?? 'gpt-3.5-turbo'),
    },
    RSS: {
      CHECK_INTERVAL: toNumber(input.RSS?.CHECK_INTERVAL, current.RSS?.CHECK_INTERVAL ?? 30),
      KEYWORDS: Array.isArray(input.RSS?.KEYWORDS) ? input.RSS.KEYWORDS : current.RSS?.KEYWORDS ?? [],
      EXCLUDE: Array.isArray(input.RSS?.EXCLUDE) ? input.RSS.EXCLUDE : current.RSS?.EXCLUDE ?? [],
    },
    FEATURES: {},
  };
  if (typeof input.ADMIN_PASSWORD === 'string' && input.ADMIN_PASSWORD.trim() !== '') {
    next.ADMIN_PASSWORD = input.ADMIN_PASSWORD.trim();
  }
  FEATURE_KEYS.forEach(key => {
    const incoming = input.FEATURES?.[key];
    if (typeof incoming === 'boolean') {
      next.FEATURES[key] = incoming;
    } else if (typeof current.FEATURES?.[key] === 'boolean') {
      next.FEATURES[key] = current.FEATURES[key];
    } else {
      next.FEATURES[key] = false;
    }
  });
  return next;
}

function filterResponse(settings) {
  return {
    BOT_TOKEN: settings.BOT_TOKEN ?? '',
    ADMIN_ID: settings.ADMIN_ID ?? '',
    TG_API_BASE: settings.TG_API_BASE ?? '',
    BINARY_URL: settings.BINARY_URL ?? '',
    BINARY_PORT: settings.BINARY_PORT ?? '',
    ADMIN_PASSWORD: '',
    MAIL: {
      HOST: settings.MAIL?.HOST ?? 'imap.gmail.com',
      PORT: settings.MAIL?.PORT ?? 993,
      USER: settings.MAIL?.USER ?? '',
      PASS: settings.MAIL?.PASS ?? '',
      DIGEST_TIME: settings.MAIL?.DIGEST_TIME ?? '08:00',
    },
    DB_PATH: settings.DB_PATH ?? './data/bot.db',
    OPENAI: {
      API_BASE: settings.OPENAI?.API_BASE ?? 'https://api.openai.com/v1',
      API_KEY: settings.OPENAI?.API_KEY ?? '',
      MODEL: settings.OPENAI?.MODEL ?? 'gpt-3.5-turbo',
    },
    RSS: {
      CHECK_INTERVAL: settings.RSS?.CHECK_INTERVAL ?? 30,
      KEYWORDS: settings.RSS?.KEYWORDS ?? [],
      EXCLUDE: settings.RSS?.EXCLUDE ?? [],
    },
    FEATURES: FEATURE_KEYS.reduce((acc, key) => {
      acc[key] = Boolean(settings.FEATURES?.[key]);
      return acc;
    }, {}),
  };
}

function requireAdmin(req, res, next) {
  let settings;
  try {
    settings = readEncryptedConfig();
  } catch (err) {
    return res.status(500).json({ message: err?.message || 'Failed to decrypt config' });
  }
  if (!settings.ADMIN_PASSWORD) {
    return res.status(403).json({ message: 'Set ADMIN_PASSWORD first' });
  }
  const password = req.get('x-admin-password') || '';
  if (password !== settings.ADMIN_PASSWORD) {
    return res.status(401).json({ message: 'Invalid password' });
  }
  return next();
}

function proxyToBinary(req, res) {
  const targetPath = req.originalUrl || '/';
  const options = {
    hostname: '127.0.0.1',
    port: 31000,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: '127.0.0.1' },
  };
  const proxyReq = http.request(options, proxyRes => {
    res.statusCode = proxyRes.statusCode || 502;
    Object.entries(proxyRes.headers).forEach(([key, value]) => {
      if (value !== undefined) res.setHeader(key, value);
    });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    res.status(502).send('Proxy error');
  });
  req.pipe(proxyReq);
}


function startServer() {
  const app = express();
  app.use(BINARY_PATH, proxyToBinary);
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/config', requireAdmin, (req, res) => {
    const settings = readEncryptedConfig();
    res.json({ data: filterResponse(settings), meta: { adminPasswordSet: Boolean(settings.ADMIN_PASSWORD) } });
  });
  app.post('/api/config', requireAdmin, (req, res) => {
    const settings = readEncryptedConfig();
    const nextSettings = normalizeSettings(req.body || {}, settings);
    writeEncryptedConfig(nextSettings);
    res.json({ data: filterResponse(nextSettings), meta: { saved: true, restartRequired: true } });
  });
  app.get('/api/bot/status', requireAdmin, (req, res) => {
    res.json({ data: getBotStatus() });
  });
  app.post('/api/bot/start', requireAdmin, async (req, res) => {
    try {
      const result = await startBot();
      res.json({ data: result });
    } catch (err) {
      res.status(400).json({ message: err?.message || 'Start failed' });
    }
  });
  app.post('/api/bot/stop', requireAdmin, async (req, res) => {
    try {
      const result = await stopBot();
      res.json({ data: result });
    } catch (err) {
      res.status(400).json({ message: err?.message || 'Stop failed' });
    }
  });
  app.get('/api/binary/status', requireAdmin, (req, res) => {
    res.json({ data: getBinaryStatus() });
  });
  app.post('/api/binary/start', requireAdmin, async (req, res) => {
    try {
      const settings = readEncryptedConfig();
      const url = req.body?.url || settings.BINARY_URL;
      const portOverride = Number.isFinite(req.body?.port)
        ? req.body.port
        : settings.BINARY_PORT;
      const result = await startBinary(url, portOverride);
      res.json({ data: result });
    } catch (err) {
      res.status(400).json({ message: err?.message || 'Start failed' });
    }
  });
  app.post('/api/binary/stop', requireAdmin, async (req, res) => {
    try {
      const result = await stopBinary();
      res.json({ data: result });
    } catch (err) {
      res.status(400).json({ message: err?.message || 'Stop failed' });
    }
  });
  app.get('/api/env', requireAdmin, (req, res) => {
    const port = process.env.PORT || process.env.SERVER_PORT || process.env.PTERODACTYL_PORT || null;
    res.json({ data: { port } });
  });
  app.get(ADMIN_PATH, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });
  app.get(`${ADMIN_PATH}/`, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });
  app.use(express.static(PUBLIC_DIR));
  const port = Number(process.env.PORT || 3097);
  return new Promise(resolve => {
    const server = app.listen(port, () => {
      
      resolve(server);
    });
    server.on('error', err => {
      
      resolve(null);
    });
  });
}

async function main() {
  await initDatabase();
  startServer();
}

main().catch((err) => {
  
  process.exit(1);
});
