const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  areJidsSameUser,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const BACKEND_BASE_URL = (process.env.BACKEND_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const BACKEND_WEBHOOK_PATH = '/webhook/message';
const BACKEND_GROUPS_WEBHOOK_PATH = '/webhook/groups';
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || '').trim();
const AUTH_STATE_DIR = path.resolve(__dirname, 'auth');
const BACKEND_TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS || 30000) || 30000;

function envBool(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return defaultValue;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

/** Log each inbound group message that mentions the bot (jid + text preview). */
const WA_LOG_INBOUND = envBool('WA_LOG_INBOUND', false);
/** POST participating groups to backend after connect (same auth as message webhook). */
const SYNC_GROUPS_TO_BACKEND = envBool('SYNC_GROUPS_TO_BACKEND', true);
/** Log every group messages.upsert (type, id, mentions) for debugging. */
const WA_DEBUG_UPSERT = envBool('WA_DEBUG_UPSERT', false);
/** Log bot output payloads (backend + sent replies). */
const WA_LOG_OUTPUT = envBool('WA_LOG_OUTPUT', true);

console.log('[wa-mcp-bot] policy: group chats only; MCP path only when this linked account is @mentioned');
console.log('[wa-mcp-bot] options:', { WA_LOG_INBOUND, SYNC_GROUPS_TO_BACKEND, WA_DEBUG_UPSERT, WA_LOG_OUTPUT });

const http = axios.create({
  baseURL: BACKEND_BASE_URL,
  timeout: BACKEND_TIMEOUT_MS,
  headers: WEBHOOK_SECRET ? { 'X-Webhook-Secret': WEBHOOK_SECRET } : {},
});

function disconnectLabel(statusCode) {
  if (statusCode == null || Number.isNaN(statusCode)) return 'unknown';
  const match = Object.entries(DisconnectReason).find(([, v]) => v === statusCode);
  return match ? `${match[0]} (${statusCode})` : String(statusCode);
}

function getBotJid(sock, credsMeId) {
  return sock.user?.id || credsMeId || undefined;
}

function mentionedJidsForMessage(msg) {
  const m = msg?.message;
  if (!m) return [];
  const carriers = [
    m.extendedTextMessage,
    m.imageMessage,
    m.videoMessage,
    m.documentMessage,
    m.audioMessage,
  ].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const c of carriers) {
    for (const j of c.contextInfo?.mentionedJid || []) {
      if (j && !seen.has(j)) {
        seen.add(j);
        out.push(j);
      }
    }
  }
  return out;
}

/** User part before @ for visible @mention in outgoing text (PN / LID / device). */
function jidMentionLabel(jid) {
  if (!jid) return 'there';
  const [userPart] = jid.split('@');
  return userPart.split(':')[0] || 'there';
}

function previewText(value, maxLen = 400) {
  const txt = typeof value === 'string' ? value : JSON.stringify(value);
  if (!txt) return '';
  return txt.length > maxLen ? `${txt.slice(0, maxLen)}…` : txt;
}

function participantJidsForMatch(p) {
  if (!p) return [];
  return [p.id, p.lid, p.phoneNumber].filter(Boolean);
}

/** Whether this group participant row is the linked (bot) account (PN / LID rows). */
function participantIsLinkedBot(p, botJid) {
  if (!p || !botJid) return false;
  return participantJidsForMatch(p).some((pid) => areJidsSameUser(pid, botJid));
}

function findParticipantByMention(mentionJid, participants) {
  return participants.find((p) =>
    participantJidsForMatch(p).some((pid) => pid === mentionJid || areJidsSameUser(pid, mentionJid))
  );
}

/**
 * True if contextInfo mentions include this linked account.
 * Resolves LID vs @s.whatsapp.net using group participant rows when needed.
 */
function messageMentionsBot(msg, botJid, groupMeta) {
  if (!botJid) return false;
  const mentioned = mentionedJidsForMessage(msg);
  if (!mentioned.length) return false;
  if (mentioned.some((jid) => areJidsSameUser(jid, botJid))) return true;
  const parts = groupMeta?.participants;
  if (!parts?.length) return false;
  return mentioned.some((m) => {
    const p = findParticipantByMention(m, parts);
    return Boolean(p && participantIsLinkedBot(p, botJid));
  });
}

/** Dedupe notify+append deliveries of the same message key (common after initial sync timeout). */
function createUpsertDeduper(maxSize = 4000) {
  const seen = new Set();
  return function shouldProcess(remoteJid, msgId) {
    const k = `${remoteJid}|${msgId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    if (seen.size > maxSize) seen.clear();
    return true;
  };
}

async function fetchParticipatingGroupsAndCache(sock, groupMetaCache) {
  const all = await sock.groupFetchAllParticipating();
  groupMetaCache.clear();
  for (const meta of Object.values(all)) {
    if (meta?.id) groupMetaCache.set(meta.id, meta);
  }
  return all;
}

async function syncParticipatingGroups(sock, groupMetaCache, httpClient) {
  try {
    const all = await fetchParticipatingGroupsAndCache(sock, groupMetaCache);
    const list = Object.values(all).map((m) => ({
      id: m.id,
      subject: m.subject || null,
      size: m.size ?? m.participants?.length ?? null,
    }));
    console.log(`[wa-mcp-bot] participating groups (${list.length}):`);
    for (const g of list) {
      console.log(`  - ${g.subject || '(no subject)'}  ${g.id}  [~${g.size ?? '?'} members]`);
    }
    if (SYNC_GROUPS_TO_BACKEND && list.length) {
      await httpClient.post(BACKEND_GROUPS_WEBHOOK_PATH, { groups: list });
      console.log('[wa-mcp-bot] group list synced to backend', BACKEND_GROUPS_WEBHOOK_PATH);
    }
  } catch (err) {
    console.error('[wa-mcp-bot] groupFetchAllParticipating failed:', err?.message || err);
  }
}

let currentSock = null;
let warnedMissingBotJid = false;

async function startBot() {
  if (currentSock) {
    try {
      currentSock.end(undefined);
    } catch {
      /* already closed */
    }
    currentSock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_STATE_DIR);

  const {
    version,
    isLatest,
    error: versionError,
  } = await fetchLatestWaWebVersion();

  if (versionError) {
    console.warn(
      '[wa-mcp-bot] fetchLatestWaWebVersion failed; using bundled defaults:',
      versionError?.message || versionError
    );
  } else {
    console.log(
      '[wa-mcp-bot] WA Web client version:',
      version.join('.'),
      isLatest ? '(live)' : '(fallback)'
    );
  }

  const groupMetaCache = new Map();
  const credsMeId = state.creds?.me?.id;

  const sock = makeWASocket({
    auth: state,
    version,
    cachedGroupMetadata: async (jid) => groupMetaCache.get(jid) ?? null,
  });
  currentSock = sock;

  const upsertSeen = createUpsertDeduper();

  sock.ev.on('groups.update', (updates) => {
    const list = Array.isArray(updates) ? updates : [updates];
    for (const u of list) {
      if (!u?.id) continue;
      const prev = groupMetaCache.get(u.id) || {};
      groupMetaCache.set(u.id, { ...prev, ...u });
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n[wa-mcp-bot] Scan this QR with WhatsApp → Linked devices → Link a device\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error;
      if (!err) {
        console.log('[wa-mcp-bot] connection closed (clean shutdown)');
        return;
      }

      const statusCode = err?.output?.statusCode;
      const data = err?.data;

      console.error('[wa-mcp-bot] connection closed:', {
        message: err?.message,
        statusCode,
        reason: disconnectLabel(statusCode),
        serverAttrs: data,
      });

      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const forbidden = statusCode === DisconnectReason.forbidden;

      if (loggedOut) {
        console.error('[wa-mcp-bot] Logged out — delete auth state dir and scan QR again:', AUTH_STATE_DIR);
        return;
      }
      if (forbidden) {
        console.error(
          '[wa-mcp-bot] Forbidden (403) — often rate-limit or account restriction. Wait and retry; avoid VPN/proxy if possible.'
        );
        return;
      }

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('[wa-mcp-bot] reconnecting in 2s…');
        setTimeout(() => {
          startBot().catch((e) => console.error('[wa-mcp-bot] reconnect failed:', e));
        }, 2000);
      }
    } else if (connection === 'open') {
      const me = getBotJid(sock, credsMeId);
      console.log(
        '[wa-mcp-bot] connected — listening in groups for @mentions of this linked account',
        me ? `(session ${me})` : ''
      );
      void syncParticipatingGroups(sock, groupMetaCache, http);
    }
  });

  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    if (type !== 'notify' && type !== 'append') return;

    const botJid = getBotJid(sock, credsMeId);
    if (!botJid && !warnedMissingBotJid) {
      warnedMissingBotJid = true;
      console.warn('[wa-mcp-bot] bot JID unknown; @mention detection disabled until creds.me / sock.user is available');
    }
    if (botJid) warnedMissingBotJid = false;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith('@g.us')) continue;

      const mentionCount = mentionedJidsForMessage(msg).length;
      if (WA_DEBUG_UPSERT) {
        console.log('[wa-mcp-bot] messages.upsert', {
          type,
          group: jid,
          id: msg.key.id,
          fromMe: msg.key.fromMe,
          participant: msg.key.participant || msg.key.participantAlt,
          mentionCount,
        });
      }

      let groupMeta = groupMetaCache.get(jid);
      if (!messageMentionsBot(msg, botJid, groupMeta)) {
        const mentioned = mentionedJidsForMessage(msg);
        const needParticipants =
          botJid &&
          mentioned.length > 0 &&
          !mentioned.some((m) => areJidsSameUser(m, botJid)) &&
          !groupMeta?.participants?.length;
        if (needParticipants) {
          try {
            const fresh = await sock.groupMetadata(jid);
            groupMetaCache.set(jid, fresh);
            groupMeta = fresh;
          } catch (e) {
            console.warn('[wa-mcp-bot] groupMetadata refresh failed:', jid, e?.message || e);
          }
        }
      }
      if (!messageMentionsBot(msg, botJid, groupMeta)) continue;
      if (!upsertSeen(jid, msg.key.id)) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        msg.message.documentMessage?.caption ||
        '';

      const query = text.replace(/@\S+/g, '').trim();

      const taggerJid = msg.key.participant || msg.key.participantAlt;
      console.log('[wa-mcp-bot] bot tagged', {
        group: jid,
        tagger: taggerJid || null,
        messageId: msg.key.id,
        rawText: text,
        queryAfterStrip: query,
        mentionedJids: mentionedJidsForMessage(msg),
      });
      if (WA_LOG_INBOUND) {
        console.log('[wa-mcp-bot] inbound (verbose)', JSON.stringify(msg.message, null, 2).slice(0, 4000));
      }

      if (taggerJid) {
        const label = jidMentionLabel(taggerJid);
        const sampleText = `@${label} sample: the bot saw your tag and is replying with an @ back to you.`;
        try {
          await sock.sendMessage(
            jid,
            { text: sampleText, mentions: [taggerJid] },
            { quoted: msg }
          );
          if (WA_LOG_OUTPUT) {
            console.log('[wa-mcp-bot] sent sample @-reply', {
              group: jid,
              to: taggerJid,
              text: previewText(sampleText),
            });
          }
        } catch (sendErr) {
          console.error('[wa-mcp-bot] sample @-reply failed:', sendErr?.message || sendErr);
        }
      } else {
        console.warn('[wa-mcp-bot] no group participant on message; skipping sample @-reply');
      }

      if (!query) continue;

      try {
        const res = await http.post(BACKEND_WEBHOOK_PATH, {
          message: query,
          user: msg.key.participant || msg.key.remoteJid,
          group: jid,
        });
        if (WA_LOG_OUTPUT) {
          console.log('[wa-mcp-bot] backend response', {
            group: jid,
            status: res.status,
            body: previewText(res.data, 1000),
          });
        }

        const reply = res.data?.reply ?? 'No response';
        await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        if (WA_LOG_OUTPUT) {
          console.log('[wa-mcp-bot] sent final reply', {
            group: jid,
            text: previewText(reply, 1000),
          });
        }
      } catch (err) {
        console.error('[wa-mcp-bot] backend error:', err?.message || err);
        try {
          await sock.sendMessage(
            jid,
            { text: '⚠️ Error processing request' },
            { quoted: msg }
          );
          if (WA_LOG_OUTPUT) {
            console.log('[wa-mcp-bot] sent error reply', {
              group: jid,
              text: '⚠️ Error processing request',
            });
          }
        } catch (sendErr) {
          console.error('[wa-mcp-bot] failed to send error reply:', sendErr?.message || sendErr);
        }
      }
    }
  });
}

startBot().catch((e) => {
  console.error('[wa-mcp-bot] fatal:', e);
  process.exit(1);
});