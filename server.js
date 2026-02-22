// server.js
import express from 'express';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { createBotRoomForUser, getUserState, handleBotMessage, lockKey, randomAIName } from './services.js';
import {redis, pub, sub} from './redis.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { botRoomTimers } from './gemini-config.js';
import { Server } from 'socket.io';

// Recreate __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// let lock = false;
// let roomSelection = false



const INSTANCE_ID = process.env.INSTANCE_ID || uuidv4(); // unique per node
console.log('INSTANCE_ID =', INSTANCE_ID);

const app = express();
const VOICE_DIR = path.join(process.cwd(), "ai-voices");
const TOTAL_CLIPS = 17;
const REDIS_TTL_MIN = 10; // seconds
const REDIS_TTL_MAX = 15; // seconds
const MAX_RETRY = 5;
const RETRY_DELAY = 3000;
const DELAY_MATCHING = 400

const room_state = {
  OFFER_SENT:"OFFER_SENT",
  OFFER_RECEIVED:"OFFER_RECEIVED",
  ANSWER_SENT:"ANSWER_SENT",
  ANSWER_RECEIVED:"ANSWER_RECEIVED"
}

const user_state = {
  IDLE:"IDLE",
  WAITING:"WAITING",
  IN_ROOM:"IN_ROOM",
  COOLDOWN:"COOLDOWN"
}

// setInterval(async () => {
//   const users = await redis.keys("user_room:*");

//   for (const key of users) {
//     const userId = key.split(":")[1];

//     const sess = await redis.exists(`sess:${userId}`);
//     const grace = await redis.exists(`grace:${userId}`);

//     if (!sess && !grace) {
//       await cleanup(userId);
//     }
//   }
// }, 15_000);

app.get("/random", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).send("userId is required");
    }

    const redisKey = `ai_voice:user:${userId}`;

    // 1️⃣ Check Redis
    let clipIndex = await redis.get(redisKey);

    // 2️⃣ If not exists → generate & store
    if (!clipIndex) {
      clipIndex = Math.floor(Math.random() * TOTAL_CLIPS) + 1;

      const ttl =
        Math.floor(Math.random() * (REDIS_TTL_MAX - REDIS_TTL_MIN + 1)) +
        REDIS_TTL_MIN;

        await redis.set(redisKey, clipIndex, "EX", ttl);
    }

    const filePath = path.join(VOICE_DIR, `${clipIndex}.mp3`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send("Audio not found");
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");

    res.sendFile(filePath);
  } catch (err) {
    console.error("Error serving random audio:", err);
    res.status(500).send("Internal server error");
  }
});


const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

app.use(express.static("public"));
app.use(express.static("ai-voices"));

// Load Lua script (match.lua) from disk
const matchLua = fs.readFileSync(path.join(__dirname, 'match.lua'), 'utf8');

// serve static UI
app.use(express.static(path.join(__dirname, 'public')));

// Route handlers for call and chat
app.get('/call', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'call', 'index.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat', 'index.html'));
});

// Local sockets map: userId -> socket (minimal - only for WebSocket objects, routing via Redis)
const localSockets = new Map(); // Only stores WebSocket objects, routing info in Redis hashmap

// Redis hashmap key for storing active connections: userId -> instance mapping
const CONNECTION_HASH_KEY = 'connections';

// REPORT: thresholds & base ban config
const REPORTS_PER_LEVEL = 10;   // every 10 unique reporters = new level
const BASE_BAN_HOURS = 1;      // level 1 = 1 hour, then doubles: 2,4,8,...

// Utility: safe send to socket
function safeSend(socket, obj) {
  try { socket.emit('message', JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

// Utility: safe send WebRTC event directly to socket
function safeSendWebRTC(socket, eventName, data, userId) {
  try { 
    if(eventName==="webrtc_offer" || eventName==="webrtc_answer"){
      console.log(eventName, "server pr ", data);
      const roomId = data.roomId;
      let retry = 0;
      const retryAttempt = async () => {
        console.log("function chala");
        retry++;
      
        socket
          .timeout(2000)
          .emit(eventName, data, async (err, res) => {
      
            // ✅ Case 1: ACK received successfully
            if (!err && res?.ok) {
              const roomStateRaw = await redis.get(`room_state:${roomId}`);
              if (!roomStateRaw) return;
      
              const roomStateData = JSON.parse(roomStateRaw);
      
              // Idempotent update
              if (eventName==="webrtc_offer" && roomStateData.state !== room_state.OFFER_RECEIVED) {
                await redis.set(
                  `room_state:${roomId}`,
                  JSON.stringify({
                    ...roomStateData,
                    state: room_state.OFFER_RECEIVED,
                    offerReceivedAt: Date.now()
                  })
                  , "EX", 20
                );
              }
              else if(roomStateData.state !== room_state.ANSWER_RECEIVED){
                // await redis.set(
                //   `room_state:${roomId}`,
                //   JSON.stringify({
                //     ...roomStateData,
                //     state: room_state.ANSWER_RECEIVED,
                //     answerReceivedAt:Date.now()
                //   })
                //   , "EX", 20
                // );
                // yha client pr answer recieved ho gya hain then we should delete the room_state now
                await redis.del(`room_state:${roomId}`);
              }
              return; // ✅ STOP retries
            }
      
            // ❌ Case 2: Timeout or bad response
            if (retry >= MAX_RETRY) {
              console.log("retyr wala con");
              cleanupRoom(userId);
              return;
            }
      
            // ✅ Controlled retry (no recursion)
            setTimeout(retryAttempt, RETRY_DELAY);
          });
          console.log("event emit hua");
      };
      
      // initial call
      retryAttempt();
    }
    else socket.emit(eventName, data); 
  } catch (e) { /* ignore */ }
}

// Helper to compute queue key
function queueKey(type, gender, preference) {
  return `wait:${type}:${gender}:${preference}`;
}


function getCallRole(room, userId){
  if(!userId) return null;

  if(room && room.caller && room.callee){
    return userId===room.caller?'caller':'callee';
  }
  return null;
}

async function getPartnerUserName(userId){
  const sessRaw = await redis.get(`sess:${userId}`);
  const sessionData = JSON.parse(sessRaw);
  if(sessionData && sessionData.username){
    return sessionData.username;
  }
  return null;
} 

// Subscribe to our instance channel for cross-node deliveries
const instanceChannel = `instance:${INSTANCE_ID}`;
sub.subscribe(instanceChannel, (err) => {
  if (err) console.error('Subscribe error', err);
  else console.log('Subscribed to', instanceChannel);
});

// sub.on('message', (channel, message) => {
//   // message expected: JSON with { target, payload }
//   try {
//     const obj = JSON.parse(message);
//     if (!obj || !obj.target) return;
//     const socket = localSockets.get(obj.target);
//     if (socket && socket.readyState === WebSocket.OPEN) {
//       safeSend(socket, obj.payload);
//     } else {
//       // target not connected here; ignore. Their sess key TTL will expire and other node may cleanup.
//     }
//   } catch (e) {
//     console.warn('bad pubsub message', e);
//   }
// });

// sendToUser: routes message via Redis hashmap and pub/sub
export async function sendToUser(userId, payload) {
  if (!userId) return;

  // Check if this is a WebRTC event that should be emitted directly
  const webrtcEvents = ['webrtc_offer', 'webrtc_answer', 'webrtc_ice', 'webrtc_connection_state'];
  const isWebRTCEvent = webrtcEvents.includes(payload.type);

  // Check Redis hashmap for connection info
  const instanceId = await redis.hget(CONNECTION_HASH_KEY, userId);
  console.log('instanceId', instanceId === INSTANCE_ID, instanceId, INSTANCE_ID, 'userId', userId);
  if (!instanceId) {
    // No connection info in Redis - user might be disconnected
    // Try local socket as fallback (might be connecting)
    const socketLocal = localSockets.get(userId);
    if (socketLocal && socketLocal.connected) {
      if (isWebRTCEvent) {
        safeSendWebRTC(socketLocal, payload.type, payload, userId);
      } else {
        safeSend(socketLocal, payload);
      }
      return;
    }
    return;
  }

  if (instanceId === INSTANCE_ID) {
    // User is on this instance - send directly via local socket
    const socket = localSockets.get(userId);
    if (socket && socket.connected) {
      if (isWebRTCEvent) {
        safeSendWebRTC(socket, payload.type, payload, userId);
      } else {
        safeSend(socket, payload);
      }
      return;
    } else {
      // Socket not found locally - remove from Redis hashmap
      await redis.hdel(CONNECTION_HASH_KEY, userId);
      return;
    }
  } else {
    // User is on different instance - use Redis pub/sub
    // For WebRTC events, we still send via message event for cross-instance
    // (the receiving instance will need to handle it)
    const channel = `instance:${instanceId}`;
    const msg = { target: userId, payload };
    await pub.publish(channel, JSON.stringify(msg));
    return;
  }
}

function clearBotTimeout(roomId){
  // clear lifetime timer if exists
  const t = botRoomTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    botRoomTimers.delete(roomId);
  }
}

async function endBotChat(roomId, userId, reason) {
  try {
    clearBotTimeout(roomId);

    const roomKey    = `room:${roomId}`;
    const roomMsgs   = `room_msgs:${roomId}`;
    const userRoom   = `user_room:${userId}`;

    // delete room + messages + mapping
    await redis.del(roomKey);
    await redis.del(roomMsgs);
    // extra checking that ye wali id us room ki info hi dlt ho rhi
    const roomIdFromUser = redis.get(userRoom);
    if(roomIdFromUser===roomId){
      await redis.del(userRoom);
    }

    // notify user that non-human chat ended
    if(reason!=='disconnected') await sendToUser(userId, {
      type: 'non_human_chat_end',   // or "non-human-chat-end" if you prefer
      roomId,
      reason
    });
  } catch (err) {
    console.error('Error in endBotChat', { roomId, userId, reason, err });
  }
}
async function endBotCall(roomId, userId, reason) {
  try {

    const roomKey    = `room:${roomId}`;
    const userRoom   = `user_room:${userId}`;

    // delete room + messages + mapping
    await redis.del(roomKey);
    await redis.del(userRoom);

    // notify user that non-human chat ended
    if(reason!=='disconnected') await sendToUser(userId, {
      type: 'non_human_call_end',   // or "non-human-chat-end" if you prefer
      roomId,
      reason
    });
  } catch (err) {
    console.error('Error in endBotCall', { roomId, userId, reason, err });
  }
}


function startBotRoomLifetime(roomId, userId) {
  // clear any previous lifetime timer
  const existing = botRoomTimers.get(roomId);
  if (existing) {
    clearTimeout(existing);
    botRoomTimers.delete(roomId);
  }

  // 60-65 seconds random
  const delayMs = 60_000 + Math.floor(Math.random() * 5_000);

  const t = setTimeout(() => {
    // fire-and-forget; we don't await here
    endBotChat(roomId, userId, 'bot_lifetime_expired')
      .catch(err => console.error('bot lifetime expire error', err));
  }, delayMs);

  botRoomTimers.set(roomId, t);
}



// Build match queues for gender/preference logic
function buildMatchQueues(want, gender, preference) {
  const myQueue = queueKey(want, gender, preference);
  const candidates = [];

  // 1. perfect match: partner gender = my preference, partner preference = my gender
  if (preference !== 'any' && gender !== 'any') {
    candidates.push(queueKey(want, preference, gender));
  }

  // 2. partner open: partner gender = my preference, partner preference = any
  if (preference !== 'any') {
    candidates.push(queueKey(want, preference, 'any'));
  }

  // 3. anyone who prefers my gender: partner gender = any, partner preference = my gender
  if (gender !== 'any') {
    candidates.push(queueKey(want, 'any', gender));
  }

  // 4. global fallback
  candidates.push(queueKey(want, 'any', 'any'));

  // remove duplicates (we currently allow own queue; additional self-checks are in Lua + Node)
  const seen = new Set();
  const attempts = [];
  for (const q of candidates) {
    if (!q) continue;
    if (seen.has(q)) continue;
    seen.add(q);
    attempts.push(q);
  }

  return { myQueue, attempts };
}

async function removeUserFromWaiting(userId) {
  // when person leaves the application removing this from waiting queue to prevent stale rooms
  const session = await redis.get(`sess:${userId}`);
  console.log("session mine is during cleaning", JSON.parse(session));
  if(session){
    const parsedSession = JSON.parse(session);
    const myUserQueueKey = queueKey(parsedSession.want, parsedSession.gender, parsedSession.preference);
    const globalQueue = queueKey(parsedSession.want, 'any', 'any');
    console.log("my queue key is", myUserQueueKey);
    await redis.zrem(myUserQueueKey, userId);
    await redis.zrem(globalQueue, userId);
  }
}

// Helper: update session JSON while preserving extra fields (interests, want, etc.)
async function touchSession(userId, patch = {}) {
  const sessKey = `sess:${userId}`;
  const raw = await redis.get(sessKey);
  let sess = {};
  if (raw) {
    try { sess = JSON.parse(raw); } catch (e) { sess = {}; }
  }
  sess = Object.assign({}, sess, patch, {
    instance: INSTANCE_ID,
    ts: Date.now()
  });
  await redis.set(sessKey, JSON.stringify(sess), 'EX', 180);
  return sess;
}

// Room leave logic
async function leaveRoomFunction(msg, msg_type, socket, ack) {
  if (!msg.roomId || !msg.userId) {
    if (ack) ack({ok:false, reason:"MISSING_ROOMID_OR_USERID"});
    safeSend(socket, { type: 'error', message: 'missing roomId or userId' });
    return;
  }

  const roomKey = `room:${msg.roomId}`;
  // Get room info BEFORE deleting it
  const room = await redis.hgetall(roomKey);
  if(room.mode==='bot'){
    clearBotTimeout(msg.roomId);
  }

  if(msg_type!=='skipped') await removeUserFromWaiting(msg.userId);
  if (room && room.a && room.b) {
    const partner = (msg.userId === room.a) ? room.b : room.a;

    // Delete room and user_room mappings
    await redis.del(roomKey);
    await redis.del(`user_room:${msg.userId}`);
    await redis.del(`user_room:${partner}`);

    // Notify partner that user left
    await sendToUser(partner, { type: 'partner_left', roomId: msg.roomId, userId: msg.userId });
    // Acknowledge to the user who left
    if (ack) ack({ok:true, type: msg_type, roomId: msg.roomId});
    safeSend(socket, { type: msg_type, roomId: msg.roomId });
  } else {
    // Room doesn't exist or invalid
    if (ack) ack({ok:false, reason:"ROOM_NOT_FOUND"});
    safeSend(socket, { type: 'error', message: 'room not found or invalid' });
  }
  return;
}

// JOIN + initial matchmaking
async function joinNewRoomCallFunction(msg, socket, type='new', ack) {
  if (!msg.userId) {
    if(ack) ack({ok:false, reason:"MISSING_USERID"})
    safeSend(socket, { type: 'error', message: 'missing userId' });
    return;
  }

  const userId = msg.userId;

  const want = msg.want || 'chat';
  const gender = msg.gender || 'any';
  const preference = msg.preference || 'any';
  const interests = Array.isArray(msg.interests) ? msg.interests : [];

  // REPORT/BAN: block globally banned users from joining
  const isBanned = await redis.exists(`ban:${userId}`);
  if (isBanned) {
    if(ack) ack({ok:false, reason:"BANNED"});
    return;
  }

  // 1) store/refresh session in Redis with instance id & profile
  await touchSession(userId, {
    want,
    gender,
    preference,
    interests,
    username: msg.username || '',
    state: user_state.WAITING,
    roomId: null
  });

  // 2) store connection -> instance mapping
  await redis.hset(CONNECTION_HASH_KEY, userId, INSTANCE_ID);

  // 3) track local socket for this instance
  localSockets.set(userId, socket);

  // 4) enqueue user in their own queue
  const { myQueue, attempts } = buildMatchQueues(want, gender, preference);
  const globalQueue = queueKey(msg.want, 'any', 'any');
  const joinedAt = Date.now();

  // 5) try to find a partner using Lua matcher on each target queue in order
  let matchedPartner = null;
  const roomId = uuidv4();
  const recentKey = `recent:${userId}`;

  for (const targetQueue of attempts) {
    try {
      const queueLen = await redis.zcard(targetQueue);
      // console.log("length of queueLen ",msg.userId, targetQueue, queueLen, Date.now());
      if (targetQueue === myQueue && queueLen <= 0) {
        continue;
      }
      // console.log("match perfom honga ab ", queueLen, targetQueue, myQueue);
      const res = await redis.eval(
        matchLua,
        0,
        targetQueue,    // 1: targetQueue
        userId,         // 2: myUserId
        recentKey,      // 3: myRecentKey (e.g. `recent:${userId}`)
        60000,          // 4: recentTTL
        600,            // 5: roomTTL
        roomId,         // 6: roomId
        0,              // 7: requireInterest (1 = ON, 0 = OFF)
        50,             // 8: maxScan (optional safety cap)
        10000
      );
      if (res) {
        matchedPartner = res;
        break;
      }
    } catch (e) {
      if(ack) ack({ok:false, reason:"ERROR"})
      console.error('match lua error', e);
    }
  }

  // 6) notify both or tell user they are waiting
  if (matchedPartner) {
    // // If user was in a bot room – end bot chat first
    const matchedPartnerRoomKey = await redis.get(`user_room:${matchedPartner}`);
    let currentBotRoomId = null;
    if(matchedPartnerRoomKey){
      const matchedPartnerRoomMode = await redis.hget(`room:${matchedPartnerRoomKey}`, 'mode');
      if(matchedPartnerRoomMode==='bot'){
        console.log("bot ending due to matched partner in join")
        await endBotChat(matchedPartnerRoomKey, matchedPartner, 'switch_to_human');
      }
    }
    if (currentBotRoomId) {
      console.log("bot ending due to current bot partner in join")
      await endBotChat(currentBotRoomId, userId, 'switch_to_human');
    }
    
    // For calls, assign caller/callee roles randomly
    
    let callerId = userId;
    let calleeId = matchedPartner;
    if (want === 'call') {
      // Randomly assign caller/callee (50/50 chance)
      if (Math.random() < 0.5) {
        callerId = matchedPartner;
        calleeId = userId;
      }
      // Store roles in room
      const roomKey = `room:${roomId}`;
      await redis.hset(roomKey, 'caller', callerId, 'callee', calleeId);
    }
    // map both users to this room (for resume)
    await redis.set(`user_room:${userId}`, roomId);
    await redis.set(`user_room:${matchedPartner}`, roomId);

    // update sessions with room info
    await touchSession(userId, { state: user_state.IN_ROOM, roomId });
    await touchSession(matchedPartner, { state: user_state.IN_ROOM, roomId });

    // Fetch partner usernames from session for matched event
    const partnerSession = await redis.get(`sess:${matchedPartner}`);
    let partnerUserName = '';
    if (partnerSession) {
      try {
        const parsed = JSON.parse(partnerSession);
        partnerUserName = parsed.username || '';
      } catch (e) { }
    }
    
    const mySession = await redis.get(`sess:${userId}`);
    let myUserName = '';
    if (mySession) {
      try {
        const parsed = JSON.parse(mySession);
        myUserName = parsed.username || '';
      } catch (e) { }
    }

    // room:<roomId> already created by Lua; we just notify
    const payloadForA = { 
      type: 'matched', 
      roomId, 
      partnerId: matchedPartner,
      partnerUserName: partnerUserName,
      want: want,
      role: (want === 'call' && callerId === userId) ? 'caller' : (want === 'call' ? 'callee' : null)
    };
    const payloadForB = { 
      type: 'matched', 
      roomId, 
      partnerId: userId,
      partnerUserName: myUserName,
      want: want,
      role: (want === 'call' && callerId === matchedPartner) ? 'caller' : (want === 'call' ? 'callee' : null)
    };

    await sendToUser(userId, payloadForA);
    if(ack) ack({ok:true});
    await sendToUser(matchedPartner, payloadForB);
  } else {
    if(type!=='retry'){
      if(globalQueue!==myQueue){
        console.log("adding to the my globalQueue");
        await redis.zadd(globalQueue, "NX", joinedAt, userId);
        const values = await redis.zrange(globalQueue, 0, -1);
        console.log("values at global queue ", values);
      }
      try {
        console.log("adding to myqueue ");
        await redis.zadd(myQueue, "NX", joinedAt, userId);
        const values = await redis.zrange(myQueue, 0, -1);
        console.log("values at myqueue are ", values);
      } catch (error) {
        if(ack) ack({ok:false, reason:"ERROR"});
        console.error("error pushing to queue", error);
      }
    }
    if(ack) ack({ok:true});
    // safeSend(socket, { type: 'waiting', queue: myQueue });
  }

  return;
}
// JOIN + initial matchmaking
async function joinNewRoomChatFunction(msg, socket, type='new', ack) {
  if (!msg.userId) {
    if (ack) ack({ok:false, reason:"MISSING_USERID"});
    safeSend(socket, { type: 'error', message: 'missing userId' });
    return;
  }

  const userId = msg.userId;

  const want = msg.want || 'chat';
  const gender = msg.gender || 'any';
  const preference = msg.preference || 'any';
  const interests = Array.isArray(msg.interests) ? msg.interests : []; // INTERESTS

  // REPORT/BAN: block globally banned users from joining
  const isBanned = await redis.exists(`ban:${userId}`);
  if (isBanned) {
    if (ack) ack({ok:false, reason:"BANNED"});
    // safeSend(socket, {
    //   type: 'banned',
    //   message: 'You have been temporarily blocked due to multiple reports.'
    // });
    return;
  }

  // Check if user is currently in a bot room
  const currentRoomId = await redis.get(`user_room:${userId}`);
  let currentBotRoomId = null;
  if (currentRoomId) {
    const currentRoom = await redis.hgetall(`room:${currentRoomId}`);
    if (currentRoom && currentRoom.mode === 'bot') {
      currentBotRoomId = currentRoomId;
    }
  }

  // 1) store/refresh session in Redis with instance id & profile
  await touchSession(userId, {
    want,
    gender,
    preference,
    interests,
    state: user_state.WAITING,
    roomId: null
  });

  // 2) store connection -> instance mapping
  await redis.hset(CONNECTION_HASH_KEY, userId, INSTANCE_ID);

  // 3) track local socket for this instance
  localSockets.set(userId, socket);

  // 4) enqueue user in their own queue
  const { myQueue, attempts } = buildMatchQueues(want, gender, preference);
  const globalQueue = queueKey('chat', 'any', 'any');
  const joinedAt = Date.now();
  // 5) try to find a partner using Lua matcher on each target queue in order
  let matchedPartner = null;
  const roomId = uuidv4();
  const recentKey = `recent:${userId}`;

  for (const targetQueue of attempts) {
    try {
      const queueLen = await redis.zcard(targetQueue);
      // console.log("length of targetQueue ", queueLen);
      if (targetQueue === myQueue && queueLen <= 1) {
        // console.log("skipping match", targetQueue, myQueue, queueLen);
        continue;
      }

      const res = await redis.eval(
        matchLua,
        0,
        targetQueue,    // 1: targetQueue
        userId,         // 2: myUserId
        recentKey,      // 3: myRecentKey (e.g. `recent:${userId}`)
        60000,          // 4: recentTTL
        600,            // 5: roomTTL
        roomId,         // 6: roomId
        0,              // 7: requireInterest (1 = ON, 0 = OFF)
        50,              // 8: maxScan (optional safety cap)
        10000
      );
      if (res) {
        matchedPartner = res;
        break;
      }
    } catch (e) {
      if (ack) ack({ok:false, reason:"ERROR"});
      console.error('match lua error', e);
    }
  }

  // 6) notify both or tell user they are waiting
  if (matchedPartner) {
    // If user was in a bot room – end bot chat first
    const matchedPartnerRoomKey = await redis.get(`user_room:${matchedPartner}`);
    if(matchedPartnerRoomKey){
      const matchedPartnerRoomMode = await redis.hget(`room:${matchedPartnerRoomKey}`, 'mode');
      if(matchedPartnerRoomMode==='bot'){
        console.log("bot ending due to matched partner in join")
        await endBotChat(matchedPartnerRoomKey, matchedPartner, 'switch_to_human');
      }
    }
    if (currentBotRoomId) {
      console.log("bot ending due to current bot partner in join")
      await endBotChat(currentBotRoomId, userId, 'switch_to_human');
    }
    
    // map both users to this room (for resume)
    await redis.set(`user_room:${userId}`, roomId);
    await redis.set(`user_room:${matchedPartner}`, roomId);

    // update sessions with room info
    await touchSession(userId, { state: user_state.IN_ROOM, roomId });
    await touchSession(matchedPartner, { state: user_state.IN_ROOM, roomId });
    
    // Fetch partner's username from session and send partner_info to both
    const partnerSession = await redis.get(`sess:${matchedPartner}`);
    let partnerUsername = '';
    if (partnerSession) {
      try {
        const parsed = JSON.parse(partnerSession);
        partnerUsername = parsed.username || '';
      } catch (e) { }
    }
    
    const mySession = await redis.get(`sess:${userId}`);
    let myUsername = '';
    if (mySession) {
      try {
        const parsed = JSON.parse(mySession);
        myUsername = parsed.username || '';
      } catch (e) { }
    }
    
    // room:<roomId> already created by Lua; we just notify
    const payloadForA = { type: 'matched', roomId, partnerId: matchedPartner, partnerUserName: partnerUsername };
    const payloadForB = { type: 'matched', roomId, partnerId: userId, partnerUserName: myUsername };
    
    // Send partner info to both users
    await sendToUser(userId, { type: 'partner_info', partnerUserName: partnerUsername });
    await sendToUser(matchedPartner, { type: 'partner_info', partnerUserName: myUsername });

    await sendToUser(userId, payloadForA);
    if (ack) ack({ok:true});
    await sendToUser(matchedPartner, payloadForB);
  } else {
    if(type!=='retry'){
      if(globalQueue!==myQueue){
        console.log("adding to the my globalQueue");
        await redis.zadd(globalQueue, "NX", joinedAt, userId);
        const values = await redis.zrange(globalQueue, 0, -1);
        console.log("values at global queue ", values);
      }
      try {
        console.log("adding to myqueue ");
        await redis.zadd(myQueue, "NX", joinedAt, userId);
        const values = await redis.zrange(myQueue, 0, -1);
        console.log("values at myqueue are ", values);
      } catch (error) {
        if (ack) ack({ok:false, reason:"ERROR"});
        console.error("error pushing to queue", error);
      }
    }
    if (ack) ack({ok:true});
    // safeSend(socket, { type: 'waiting', queue: myQueue });
  }

  return;
}


// REPORT: handle user reports (block + escalating bans)
async function handleReport(socket, msg, ack) {
  const reporterId = msg.userId;
  const targetId   = msg.targetId;
  const roomId     = msg.roomId;
  const reason     = msg.reason || null;

  if (!reporterId || !targetId || !roomId) {
    if(ack) ack({ok:false, reason:"reporterId or targetId or roomId not provided"});
    return;
  }
  if (reporterId === targetId){
    if (ack) ack({ok:false, reason:"Failed"});
    return;
  }
  const roomKey = `room:${roomId}`;
  const room = await redis.hgetall(roomKey);

  // sanity check: was reporter actually in this room?
  if (!room || !room.a || !room.b ||
      (room.a !== reporterId && room.b !== reporterId)) {
    // invalid report; ignore
    if(ack) ack({ok:false, reason:"Failed"});
    return;
  }

  // 1) pairwise block: reporter never sees target again
  await redis.sadd(`block:${reporterId}`, targetId);
  // If you want symmetric blocking, also do:
  // await redis.sadd(`block:${targetId}`, reporterId);

  // 2) add unique report
  const reportsKey = `reports:${targetId}`;
  const wasNewReport = await redis.sadd(reportsKey, reporterId);
  if (wasNewReport === 0) {
    // reporter already reported this target before
    // safeSend(socket, { type: 'report_ok', targetId, roomId, dedup: true });
    if(ack) ack({ok:true});
    // still dissolve the room on duplicate report if you want:
    await dissolveRoomAfterReport(roomId, reporterId, targetId);
    return;
  }

  // 3) count total unique reporters
  const totalReports = await redis.scard(reportsKey);

  // 4) compute new ban level (1 for 10–19, 2 for 20–29, ...)
  const newLevel = Math.floor(totalReports / REPORTS_PER_LEVEL);
  if (newLevel > 0) {
    const currentLevelRaw = await redis.get(`banLevel:${targetId}`);
    const currentLevel = currentLevelRaw ? parseInt(currentLevelRaw, 10) : 0;

    if (newLevel > currentLevel) {
      // escalate ban
      const hours   = BASE_BAN_HOURS * Math.pow(2, newLevel - 1); // 1,2,4,8,...
      const seconds = hours * 3600;

      await redis.set(`ban:${targetId}`, '1', 'EX', seconds);
      await redis.set(`banLevel:${targetId}`, String(newLevel));

      // Notify target if online
      await sendToUser(targetId, {
        type: 'banned',
        durationHours: hours,
        reason: 'Multiple users reported your behaviour'
      });
      console.log(`User ${targetId} banned at level ${newLevel} for ${hours}h (reports=${totalReports})`);
    }
  }

  // 5) Ack reporter
  // safeSend(socket, { type: 'report_ok', targetId, roomId, totalReports });
  if(ack) ack({ok:true, message:"Reported"});

  // 6) Dissolve the room between these two users
  await dissolveRoomAfterReport(roomId, reporterId, targetId);
}

// helper: clean up room + mappings + notify both sides
async function dissolveRoomAfterReport(roomId, reporterId, targetId) {
  try {
    const roomKey    = `room:${roomId}`;
    const roomMsgKey = `room_msgs:${roomId}`;
    const reporterRoomKey = `user_room:${reporterId}`;
    const targetRoomKey   = `user_room:${targetId}`;

    // delete room + messages
    await redis.del(roomKey);
    await redis.del(roomMsgKey);

    // delete user→room mappings
    await redis.del(reporterRoomKey);
    await redis.del(targetRoomKey);

    // // notify reporter (client: show toast + join new partner if you want)
    // await sendToUser(reporterId, {
    //   type: 'room_closed',
    //   roomId,
    //   reason: 'reported_partner'
    // });

    // notify reported user (if they’re still around)
    await sendToUser(targetId, {
      type: 'room_closed',
      roomId,
      reason: 'being_reported'
    });

  } catch (err) {
    console.error('Error dissolving room after report', { roomId, reporterId, targetId, err });
  }
}

async function cleanupUser(userId) {
  try {
    const roomId = await redis.get(`user_room:${userId}`);
    const roomMode = await redis.hget(`room:${roomId}`, 'mode');
    if(room && room.mode==='bot'){
      clearBotTimeout(roomId);
    }
  } catch (error) {
    
  }
  await removeUserFromWaiting(userId);
  await delMatchClaim(userId);
  await delRoomMapping(userId); // user leaves room
  await touchSession(userId, { state: user_state.IDLE, roomId:null });
}

async function delMatchClaim(userId){
  try {
    await redis.del(`match_claim:${userId}`);
  } catch (error) {
    console.log("error deleting match claim ", error);
  }
}

async function delRoomMapping(userId){
  // Remove partner's user_room mapping as well (room is gone)
  try {
    await redis.del(`user_room:${userId}`);
  } catch (e) {
    console.error('Error deleting partner user_room key', e);
  }
}

async function delRoomMsg(roomId){
  // delete room messages list: room_msg:<roomId>
  const roomMsgKey = `room_msg:${roomId}`;
  try {
    await redis.del(roomMsgKey);
  } catch (e) {
    console.error('Error deleting room_msg list', e);
  }
}

async function delRoom(roomId){
  // delete room hash: room:<roomId>
  const roomKey = `room:${roomId}`
  try {
    await redis.del(roomKey);
  } catch (e) {
    console.error('Error deleting room hash', e);
  }
}

async function delRoomState(roomId) {
  // delete room hash: room:<roomId>
  const roomState = `room_state${roomId}`
  try {
    await redis.del(roomState);
  } catch (e) {
    console.error('Error deleting room State', e);
  }
}

async function removeFromRedisConnection(userId) {
  // Remove from Redis connection hashmap
  try {
    await redis.hdel(CONNECTION_HASH_KEY, userId);
  } catch (e) {
    console.error('Error hdel connection hash', e);
  }
}

const cleanupRoom = async (userId) => {
  console.log("cleanup room function", userId);

  try {
    const roomId = await redis.get(`user_room:${userId}`);
    await removeUserFromWaiting(userId);

    // Always clean own claim
    await delMatchClaim(userId);

    if (!roomId) {
      await removeFromRedisConnection(userId);
      await touchSession(userId, { state: user_state.IDLE, roomId:null });
      // sendToUser(userId, {type:"error"});
      return;
    }

    const roomKey = `room:${roomId}`;
    const roomData = await redis.hgetall(roomKey);
    const roomMode = await redis.hget(roomKey, 'mode');

    let partnerId = null;
    if (roomData && (roomData.a || roomData.b)) {
      partnerId = roomData.a === userId ? roomData.b : roomData.a;
    }

    // Handle bot room separately
    if (roomMode === 'bot') {
      await endBotChat(roomId, userId, 'disconnected');
    }

    // 🔥 HARD COMMIT: remove room first
    await delRoom(roomId);
    await delRoomState(roomId);
    await delRoomMsg(roomId);

    // Remove room mappings
    await delRoomMapping(userId);
    if (partnerId) {
      await delRoomMapping(partnerId);
      await removeUserFromWaiting(partnerId);
    }

    // Notify partner AFTER room is gone
    if (partnerId) {
      sendToUser(partnerId, {
        type: "partner_left",
        roomId,
        userId
      });

      // Partner becomes idle (but NOT cleaned)
      await touchSession(partnerId, { state: user_state.IDLE, roomId:null });
    }

    // Cleanup user session
    await removeFromRedisConnection(userId);
    await touchSession(userId, { state: user_state.IDLE, roomId:null });
    sendToUser(userId, {type:"partner_left"});

  } catch (err) {
    console.error("Error in cleanup for user", userId, err);
  }
};


async function partnerAvailablity(userId) {
  console.log("heartbeet chala ", Date.now());
  const roomId = await redis.get(`user_room:${userId}`);
  if (!roomId){
    // console.log("closing own room");
    // sendToUser(userId, {type:"room_closed"});
    return;
  }

  const room = await redis.hgetall(`room:${roomId}`);
  if (!room){
    console.log("cleaning own room ", Date.now());
    await cleanupRoom(userId);
    return;
  }

  const partnerId = room.a === userId ? room.b : room.a;

  const partnerSession = await redis.get(`sess:${partnerId}`);
  const graceExist = await redis.exists(`grace:${partnerId}`);
  if (!partnerSession && !graceExist) {
    // Partner is dead
    console.log("cleaning partner room ", Date.now());
    await cleanupRoom(partnerId);
    return;
  }
   // safe parse
   let partnerSessionData = null;
   if (partnerSession) {
     partnerSessionData = JSON.parse(partnerSession);
   }
  if(partnerSessionData?.state===user_state.IDLE || partnerSessionData?.state===user_state.WAITING){
    console.log("cleaning own room and partner is idle ", Date.now());
    cleanupUser(userId);
    return;
  }
}


// Connection handling
io.on('connection', async (socket) => {
  const userId = socket.handshake.auth?.userId;
  console.log("socket connected ", userId);
  if (!userId) {
    socket.disconnect(true);
    return;
  }
  socket.userId = userId; // 🔒 IMMUTABLE
  try {
    await redis.del(`grace:${userId}`);
  } catch (error) {
    console.log("error deleting grace ", error);
  }
  touchSession(socket.userId, {});
  // WebRTC direct event handlers
  socket.on('webrtc_offer', async (msg, ack) => {
    const roomKey = `room:${msg.roomId}`;
    const room = await redis.hgetall(roomKey);
    if (!room || !room.a) {
      if (ack) ack({ok:false, reason:"ROOM_NOT_FOUND"});
      return;
    }
    const roomState = await redis.get(`room_state:${msg.roomId}`);
    console.log("roomState ", roomState);
    if(roomState){
      if(ack) ack({ok:true});
      return;
    }
    const a = room.a, b = room.b;
    const partnerId = (msg.from === a) ? b : a;

    // store pending offer
    await redis.set(
      `pending_offer:${msg.roomId}`,
      JSON.stringify({ from: msg.from, to: partnerId, offer:msg.offer }),
      "EX",
      20
    );

    // forward offer to callee (sendToUser handles WebRTC events correctly)
    await sendToUser(partnerId, {
      type: 'webrtc_offer',
      roomId: msg.roomId,
      from: msg.from,
      offer: msg.offer
    });

    // WAIT for c2 ACK (store resolver)
    await redis.set(`room_state:${msg.roomId}`, JSON.stringify({ from: partnerId, to: msg.from, state: room_state.OFFER_SENT}), "EX", 20);
    // yha ack mt kro isse better hain ack ko store kro and then jab answer aa jaye tb ack krdo so incase answer nhi aaya then client fir se offer bhejegaa    
    if (ack) ack({ok:true});
  });

  socket.on('webrtc_answer', async (msg, ack) => {
    const roomKey = `room:${msg.roomId}`;
    const room = await redis.hgetall(roomKey);
    if (!room || !room.a) {
      if (ack) ack({ok:false, reason:"ROOM_NOT_FOUND"});
      return;
    }
    const a = room.a, b = room.b;
    const partnerId = (msg.from === a) ? b : a;
    
    const roomStateRaw = await redis.get(`room_state:${msg.roomId}`);
    const roomStateData = JSON.parse(roomStateRaw);
    if(roomStateData.state===room_state.ANSWER_SENT || roomStateData.state === room_state.ANSWER_RECEIVED){
      if(ack) ack({ok:true});
      return;
    }
    // forward answer to caller (sendToUser handles WebRTC events correctly)
    await sendToUser(partnerId, {
      type: 'webrtc_answer',
      roomId: msg.roomId,
      from: msg.from,
      answer: msg.answer
    });
    await redis.set(`room_state:${msg.roomId}`, JSON.stringify({...roomStateData, state:room_state.ANSWER_SENT}), "EX", 20);
    if (ack) ack({ok:true});
  });
  socket.on('webrtc_ice', async (msg) => {
    const roomKey = `room:${msg.roomId}`;
    const room = await redis.hgetall(roomKey);
    if (!room || !room.a) {
      return;
    }
    const a = room.a, b = room.b;
    const partnerId = (msg.from === a) ? b : a;

    // forward ICE candidate to partner (sendToUser handles WebRTC events correctly)
    await sendToUser(partnerId, {
      type: 'webrtc_ice',
      roomId: msg.roomId,
      from: msg.from,
      candidate: msg.candidate
    });
  });

  socket.on('webrtc_connection_state', async (msg) => {
    const roomKey = `room:${msg.roomId}`;
    const room = await redis.hgetall(roomKey);
    if (!room || !room.a) {
      return;
    }
    const a = room.a, b = room.b;
    const partnerId = (msg.from === a) ? b : a;

    // notify partner about connection state change (sendToUser handles WebRTC events correctly)
    await sendToUser(partnerId, {
      type: 'webrtc_connection_state',
      roomId: msg.roomId,
      from: msg.from,
      state: msg.state
    });
  });

  // JOIN event handler
  socket.on('join', async (msg, ack) => {
    const lckKey = lockKey(msg.userId);
    const acquired = await redis.set(
        lckKey,
        "1",
        "NX",
        "EX",
        5
      );

    if (!acquired){
      if (ack) ack({ok:false, reason:"BUSY"});
      return;
    }
    const USER_CURRENT_STATE = await getUserState(socket.userId);
    if (USER_CURRENT_STATE===user_state.WAITING) return;
    if (USER_CURRENT_STATE === user_state.COOLDOWN) return;
    await touchSession(socket.userId, {state:user_state.COOLDOWN});
    try {
      if(msg.want==='call'){
        setTimeout(async ()=>{
          const userLatestState = await getUserState(socket.userId);
          if(userLatestState!==user_state.COOLDOWN) return;
          await touchSession(socket.userId, {state:user_state.WAITING});
          await joinNewRoomCallFunction(msg, socket, 'new', ack);
        }, DELAY_MATCHING)
      }
      else{
        setTimeout(async ()=>{
          const userLatestState = await getUserState(socket.userId);
          if(userLatestState!==user_state.COOLDOWN) return;
          await touchSession(socket.userId, {state:user_state.WAITING});
          await joinNewRoomChatFunction(msg, socket, 'new', ack);
        }, DELAY_MATCHING)
      }
      // ack is handled inside joinNewRoomCallFunction/joinNewRoomChatFunction
    } catch (error) {
      console.error(error);
      if (ack) ack({ok:false, reason:"JOIN_FAILED"});
    }
    finally{
      await redis.del(lckKey);
    }
  });

  // REPORT event handler
  socket.on('report', async (msg, ack) => {
    await handleReport(socket, msg, ack);
  });

  // LEAVE event handler
  socket.on('leave', async (msg, ack) => {
    await leaveRoomFunction(msg, "leave_ok", socket, ack);
  });

  // SKIP event handler
  socket.on('skip', async (msg, ack) => {
    await leaveRoomFunction(msg, "skipped", socket, ack);
    const lckKey = lockKey(msg.userId);
    const acquired = await redis.set(
        lckKey,
        "1",
        "NX",
        "EX",
        5
      );

    if (!acquired){
      if (ack) ack({ok:false, reason:"BUSY"});
      return;
    }
    const USER_CURRENT_STATE = await getUserState(socket.userId);
    if(USER_CURRENT_STATE===user_state.WAITING) return;
    if (USER_CURRENT_STATE === user_state.COOLDOWN) return;
    await touchSession(socket.userId, {state:user_state.COOLDOWN});
    try {
      if(msg.want==='call'){
        setTimeout(async ()=>{
          const userLatestState = await getUserState(socket.userId);
          if(userLatestState!==user_state.COOLDOWN) return;
          await touchSession(socket.userId, {state:user_state.WAITING});
          await joinNewRoomCallFunction(msg, socket, 'new', ack);
        }, DELAY_MATCHING)
      }
      else{
        setTimeout(async ()=>{
          const userLatestState = await getUserState(socket.userId);
          if(userLatestState!==user_state.COOLDOWN) return;
          await touchSession(socket.userId, {state:user_state.WAITING});
          await joinNewRoomChatFunction(msg, socket, 'new', ack);
        }, DELAY_MATCHING)
      }
      // ack is handled inside joinNewRoomCallFunction/joinNewRoomChatFunction
    } catch (error) {
      console.error(error);
      if (ack) ack({ok:false, reason:"JOIN_FAILED"});
    }
    finally{
      await redis.del(lckKey);
    }
  });

  // RESET_START event handler
  socket.on('reset_start', async (msg, ack) => {
    console.log("RESET TO START ");
    await cleanupUser(msg.userId, "RESET_START");
    if (ack) ack({type:"RESET_START_ACK"});
  });

  // RETRY_MATCH event handler
  socket.on('retry_match', async (msg, ack) => {
    const lckKey = lockKey(msg.userId);
    const acquired = await redis.set(
        lckKey,
        "1",
        "NX",
        "EX",
        5
      );

    if (!acquired) {
      if (ack) ack({ok:false, reason:"BUSY"});
      return;
    }
    
    const userId = msg.userId;
    if (!userId) {
      if (ack) ack({ok:false, reason:"MISSING_USERID"});
      await redis.del(lckKey);
      return;
    }
    
    // Ban check
    const isBanned = await redis.exists(`ban:${userId}`);
    if (isBanned) {
      if (ack) ack({ok:false, reason:"BANNED"});
      await redis.del(lckKey);
      return;
    }
    
    if(msg.want==='call'){
      try {
        await joinNewRoomCallFunction(msg, socket, 'retry', ack);
      } catch (error) {
        console.log(error);
        if (ack) ack({ok:false, reason:"ERROR"});
      }
      finally{
        await redis.del(lckKey);
      }
      return;
    }
    
    try {
      // Check if user is currently in a bot room
      const currentRoomId = await redis.get(`user_room:${userId}`);
      let currentBotRoomId = null;
      if (currentRoomId) {
        const currentRoom = await redis.hgetall(`room:${currentRoomId}`);
        if (currentRoom && currentRoom.mode === 'bot') {
          currentBotRoomId = currentRoomId;
        }
      }

      const { want, gender, preference } = msg;
      const { myQueue, attempts } = buildMatchQueues(want, gender, preference);
      const roomId = uuidv4();
      const recentKey = `recent:${userId}`;

      let matchedPartner = null;

      for (const targetQueue of attempts) {
        try {
          const res = await redis.eval(
            matchLua,
            0,
            targetQueue,    // 1: targetQueue
            userId,         // 2: myUserId
            recentKey,      // 3: myRecentKey (e.g. `recent:${userId}`)
            60000,          // 4: recentTTL
            600,            // 5: roomTTL
            roomId,         // 6: roomId
            0,              // 7: requireInterest (1 = ON, 0 = OFF)
            50,             // 8: maxScan (optional safety cap)
            10000
          );        
          if (res) {
            matchedPartner = res;
            break;
          }
        } catch (e) {
          if (ack) ack({ok:false, reason:"ERROR"});
          console.error('match lua error', e);
        }
      }

      if (matchedPartner) {
        // If user was in a bot room – end bot chat first
        const matchedPartnerRoomKey = await redis.get(`user_room:${matchedPartner}`);
        if(matchedPartnerRoomKey){
          const matchedPartnerRoomMode = await redis.hget(`room:${matchedPartnerRoomKey}`, 'mode');
          if(matchedPartnerRoomMode==='bot'){
            if(want==='call') await endBotCall(matchedPartnerRoomKey, matchedPartner, 'switch_to_human');
            else await endBotChat(matchedPartnerRoomKey, matchedPartner, 'switch_to_human');
          }
        }
        if (currentBotRoomId) {
          if(want==='call') await endBotCall(currentBotRoomId, userId, 'switch_to_human')
          else await endBotChat(currentBotRoomId, userId, 'switch_to_human');
        }

        // Fetch partner's username from session and send partner_info to both
        const partnerSession = await redis.get(`sess:${matchedPartner}`);
        let partnerUsername = '';
        if (partnerSession) {
          try {
            const parsed = JSON.parse(partnerSession);
            partnerUsername = parsed.username || '';
          } catch (e) { }
        }
        
        const mySession = await redis.get(`sess:${userId}`);
        let myUsername = '';
        if (mySession) {
          try {
            const parsed = JSON.parse(mySession);
            myUsername = parsed.username || '';
          } catch (e) { }
        }
        const payloadForA = { type: 'matched', roomId, partnerId: matchedPartner, partnerUserName:myUsername };
        const payloadForB = { type: 'matched', roomId, partnerId: userId, partnerUserName:partnerUsername };

        await redis.set(`user_room:${userId}`, roomId);
        await redis.set(`user_room:${matchedPartner}`, roomId);

        await touchSession(userId, { state: user_state.IN_ROOM, roomId });
        await touchSession(matchedPartner, { state:user_state.IN_ROOM, roomId });

        await sendToUser(userId, payloadForA);
        if (ack) ack({ok:true});
        await sendToUser(matchedPartner, payloadForB);
      } else {
        // No human match this time:
        // - if user was already in bot room, they just continue that chat until lifetime expires.
        // - if not in any room, you can decide to create a bot room or just keep waiting.
        if (!currentBotRoomId) {
          // Optional: fallback to bot only if NOT already in a bot conversation
          await createBotRoomForUser(userId, want, gender, preference);
        }
        if (ack) ack({ok:true});
      }
    } catch (error) {
      console.log(error);
      if (ack) ack({ok:false, reason:"ERROR"});
    } finally{
      await redis.del(lckKey);
    }
  });

  socket.on('message', async (raw, ack) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    console.log('msg recieved ', msg);
    
    // RESUME
    if (msg.type === 'resume') {
      const resumeId = socket.userId;

      if (!resumeId) {
        safeSend(socket, { type: 'resume_failed', reason: 'no_user_id' });
        return;
      }

      const sessKey = `sess:${resumeId}`;
      const roomKeyForUser = `user_room:${resumeId}`;
      let sessRaw = null;
      let currentRoomId = null;
      try {
        sessRaw = await redis.get(sessKey);
        currentRoomId = await redis.get(roomKeyForUser);
        console.log("current room id", currentRoomId);
      } catch (error) {
        console.log("error ", error);
      }
      // ❗ Allow resume ONLY if BOTH are missing
      if (!sessRaw && !currentRoomId) {
        safeSend(socket, { type: 'resume_failed', reason: 'no_state_to_resume' });
        return;
      }
      // ✅ Now bind socket (safe)
      await touchSession(resumeId,{});
      let sessionData = null;
      if (sessRaw) {
        try {
          sessionData = JSON.parse(sessRaw);
        } catch (e) {
          console.error("Invalid session JSON for", resumeId, e);
          await redis.del(sessKey); // optional but recommended
          await cleanupRoom(userId);
          return;
        }
      }
      await redis.hset(CONNECTION_HASH_KEY, resumeId, INSTANCE_ID);
      localSockets.set(resumeId, socket);
      let messages = [];
      let partnerId = null;
      let room = null;

      if (currentRoomId) {
        const roomKey = `room:${currentRoomId}`;
        room = await redis.hgetall(roomKey);

        if (room && room.a && room.b) {
          partnerId = resumeId === room.a ? room.b : room.a;
        }

        const msgsKey = `room_msgs:${currentRoomId}`;
        const rawList = await redis.lrange(msgsKey, 0, 49);
        rawList.reverse();

        messages = rawList
          .map(s => {
            try { return JSON.parse(s); } catch { return null; }
          })
          .filter(Boolean);
      }
      const callRole = getCallRole(room, socket.userId);
      const partnerUserName = await getPartnerUserName(partnerId);

      if(currentRoomId || msg.want==='chat'){
        setTimeout(() => {
          safeSend(socket, {
            type: 'resume_ok',
            userId: resumeId,
            instance: INSTANCE_ID,
            roomId: currentRoomId || null,
            partnerId,
            messages,
            state: sessionData?.state ?? (
              currentRoomId ? user_state.IN_ROOM : user_state.IDLE
            ),
            callRole,
            partnerUserName
          });
        }, 900);
        
      }
      else{
        console.log("role nhi hain");
        cleanupRoom(socket.userId);
      } 

      return;
    }

    // AUTH
    if (msg.type === 'auth') {
      const userId = socket.userId;
      const sessKey = `sess:${userId}`;

      const session = await touchSession(userId, {
        state: user_state.IDLE,
        roomId: null
      });

      // Store connection in Redis hashmap: userId -> instance
      await redis.hset(CONNECTION_HASH_KEY, userId, INSTANCE_ID);

      // track local socket for receiving pub/sub messages
      localSockets.set(userId, socket);

      // respond with the assigned userId
      safeSend(socket, { type: 'auth_ok', userId: userId, instance: INSTANCE_ID,state:session.state });
      return;
    }


    if (msg.type === 'non-human-chat'){
      const userId = msg.userId;
      const alreadyRoom = await redis.get(`user_room:${userId}`);
      let messages = [];
      if(alreadyRoom){
        const rawList = await redis.lrange(`room_msgs:${alreadyRoom}`, 0, 49);
        rawList.reverse();

        messages = rawList
          .map(s => {
            try { return JSON.parse(s); } catch { return null; }
          })
          .filter(Boolean);
        const room = await redis.hgetall(`room:${alreadyRoom}`);
        sendToUser(userId, {type:"room_exist", roomId:alreadyRoom, messages, partnerId:room.b});
        return;
      }
      // const mode = await redis.hget(`room:${alreadyRoom}`, 'mode');
      // if(alreadyRoom && mode==='bot'){
      //   console.log("bot ending due to non human chat start")
      //   await endBotChat(alreadyRoom, userId, 'switch_to_human');
      // }
      const {roomId, botId } = await createBotRoomForUser(userId, msg.want, msg.gender, msg.preference);
      await sendToUser(userId, {
        type: 'matched_bot',
        roomId,
        partnerId: botId
      });
      // start absolute lifetime (10–15s) for this bot chat
      startBotRoomLifetime(roomId, userId);
    }
    if (msg.type === 'non-human-call'){
      const userId = msg.userId;
      const alreadyRoom = await redis.get(`user_room:${userId}`);
      if (alreadyRoom) {
        const room = await redis.hgetall(`room:${alreadyRoom}`);
    
        if (room && room.a && room.b) {
          const partnerId = room.a === userId ? room.b : room.a;
          const partnerRoom = await redis.get(`user_room:${partnerId}`);
    
          if (partnerRoom === alreadyRoom) {
            // Both users still in same room → teardown
            try {
              await redis.del(
                `user_room:${userId}`,
                `user_room:${partnerId}`,
                `room:${alreadyRoom}`,
                `room_msgs:${alreadyRoom}`
              );
            } catch (error) {
              console.log("error in deleting room when room already exist ", error)
            }
    
            sendToUser(userId, {
              type: "partner_left",
              roomId: alreadyRoom,
              reason: "switch_to_non_human"
            });
    
            sendToUser(partnerId, {
              type: "partner_left",
              roomId: alreadyRoom,
              reason: "partner_switched_to_non_human"
            });
    
            return;
          }
        }
    
        // fallback cleanup
        await redis.del(`user_room:${userId}`);
      }    
      // const mode = await redis.hget(`room:${alreadyRoom}`, 'mode');
      // if(alreadyRoom && mode==='bot'){
      //   console.log("bot ending due to non human chat start")
      //   await endBotChat(alreadyRoom, userId, 'switch_to_human');
      // }
      const {roomId, botId } = await createBotRoomForUser(userId, msg.want, msg.gender, msg.preference);
      const username = randomAIName();
      await sendToUser(userId, {
        type: 'matched_bot',
        roomId,
        partnerId: botId,
        partnerUserName:username
      });
      // isko change krna hain
      // startBotRoomLifetime(roomId, userId);
    }
    if (msg.type==='non-human-call-end'){
      endBotCall(msg.roomId, msg.userId, "Time Expired");
    }

    // text messages (relay via Redis-based routing)
    if (msg.type === 'text') {
      await touchSession(socket.userId, {});
      console.log("text is ", msg);
      // msg: { type:'text', roomId, from, body, seq }
      const roomKey = `room:${msg.roomId}`;
      const room = await redis.hgetall(roomKey);
      if (!room || !room.a) {
        safeSend(socket, { type: 'error', message: 'room not found' });
        return;
      }

      // ---------- BOT ROOM BRANCH ----------
      // We treat this as a bot conversation if:
      //   - room.mode === 'bot' (preferred), OR
      //   - partner id looks like "bot:xxx"
      if (room.mode === 'bot' || (room.b && room.b.startsWith('bot:'))) {
        // Immediately ACK so UI can show double-tick logic etc.
        safeSend(socket, { type: 'text_ack', seq: msg.seq, ts: Date.now() });

        // Forward to Gemini handler (this will:
        //  - store user message in room_msgs:<roomId>
        //  - call Gemini
        //  - simulate typing + delay
        //  - send bot reply back to user
        await handleBotMessage(room, msg);
        return;
      }

      const a = room.a, b = room.b;
      const targetId = (msg.from === a) ? b : a;
      const payload = { type: 'text', roomId: msg.roomId, from: msg.from, body: msg.body, seq: msg.seq, ts: Date.now() };
      console.log('sending text to', targetId, payload);
      await sendToUser(targetId, payload);

      // ack sender
      safeSend(socket, { type: 'text_ack', seq: msg.seq, ts: Date.now() });

      // store in Redis history (LPUSH + LTRIM)
      const msgsKey = `room_msgs:${msg.roomId}`;
      await redis.lpush(msgsKey, JSON.stringify(payload));
      await redis.ltrim(msgsKey, 0, 49); // keep last 50 messages

      return;
    }

    // preoffer exchange (store in redis and forward to partner)
    if (msg.type === 'preoffer') {
      // msg: { type:'preoffer', roomId, from, localDesc }
      const roomKey = `room:${msg.roomId}`;
      const room = await redis.hgetall(roomKey);
      if (!room || !room.a) {
        safeSend(socket, { type: 'error', message: 'room not found' });
        return;
      }
      const a = room.a, b = room.b;
      const partnerId = (msg.from === a) ? b : a;

      // store preoffer in redis for partner to fetch (if offline) TTL=90
      const preKey = `preoffer:${msg.roomId}:${msg.from}`;
      await redis.set(preKey, JSON.stringify(msg.localDesc || {}), 'EX', 90);

      // forward to partner
      await sendToUser(partnerId, { type: 'preoffer', roomId: msg.roomId, from: msg.from, localDesc: msg.localDesc });
      return;
    }

    if (msg.type === 'webrtc_answer_ok') {
      if (ack) ack({ok:true, message:"Answer delivered"});
      return;
    }

    // update user's interests for matchmaking
    if (msg.type === 'interest_updated') {
      const uId = msg.userId;
      const interests = Array.isArray(msg.interests) ? msg.interests : [];

      if (!uId) {
        safeSend(socket, { type: 'error', message: 'missing userId for interest_updated' });
        return;
      }

      const key = `interests:${uId}`;

      try {
        // wipe existing interests
        await redis.del(key);

        // normalize and save new ones
        if (interests.length > 0) {
          // optional: normalize to lowercase, filter unknowns, etc.
          const normalized = interests
            .map(String)
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);

          if (normalized.length > 0) {
            await redis.sadd(key, ...normalized);
          }
        }

        safeSend(socket, {
          type: 'interest_updated_ok',
          userId: uId,
          interests
        });
      } catch (e) {
        console.error('error updating interests', e);
        safeSend(socket, { type: 'error', message: 'failed_to_update_interests' });
      }
      return;
    }




    if (msg.type === 'typing') {
      const userRoom = await redis.get(`user_room:${msg.from}`);
      if (!userRoom) return;
      const roomInfo = await redis.hgetall(`room:${userRoom}`);
      if (!roomInfo || !roomInfo.a || !roomInfo.b) return;
      const partnerId = (msg.from === roomInfo.a) ? roomInfo.b : roomInfo.a;
      sendToUser(partnerId, { type: 'typing', from: msg.from, state: msg.state });
      return;
    }

    if(msg.type==='peer_muted'){
      const roomId = msg.roomId;
      const userId = msg.userId;
      if(!userId){
        // isko krna hain if any problem fir se auth krwao
        // socket.emit("room_closed");
      }
      if(!roomId){
        sendToUser(msg.userId, {message:"room_closed"});
      }
      const roomKey = `room:${msg.roomId}`;
      const room = await redis.hgetall(roomKey);
      if (room && room.a && room.b) {
        const partner = (userId === room.a) ? room.b : room.a;
        // console.log("muted thingy ", msg.userId, partner, room);
        sendToUser(partner, {type:"peer_muted", muted:msg.muted});
      }
    }

    if(msg.type==='get_partner_info'){
      // Fetch partner's username from session and send partner_info to both
      console.log("partner info");
      const roomId = await redis.get(`user_room:${socket.userId}`);
      const room = await redis.hgetall(`room:${roomId}`)
      console.log("partner info ", roomId, room);
      if(!room){
        console.log("partner nhi hain");
        await cleanupRoom(socket.userId);
        return;
      }
      const partnerId = room.a===socket.userId?room.b:room.a;
      const mySession = await redis.get(`sess:${partnerId}`);
      console.log("sesion of mine is ", mySession);
      let myUsername = '';
      if (mySession) {
        try {
          const parsed = JSON.parse(mySession);
          myUsername = parsed.username || '';
        } catch (e) { }
      }
      else{
        sendToUser(msg.userId, {type:'room_closed'});
        return;
      }
      sendToUser(msg.userId, {type:"partner_info", partnerUserName:myUsername});
      }
  }); 

  socket.on('hb', async()=>{
    console.log("hb for user ", socket.userId);
      await touchSession(socket.userId, {});
      await partnerAvailablity(socket.userId);
      await redis.hset(CONNECTION_HASH_KEY, socket.userId, INSTANCE_ID);
      return;
  })
  socket.on('close', async () => {
    console.log("close main cleanup call hua ");
    // impovement needed here 
    await cleanupRoom(socket.userId);
    
  });
  socket.on('disconnect', async () => {
    console.log("disconnect ho gya client ", socket.userId);
    await redis.set(`grace:${socket.userId}`, 1, "EX", 10);
    // console.log("closing connection ",localSockets[socket], myUserId);
    // await cleanup(socket.userId);
    
  });
  
  socket.on('error', async () => {
    // console.log("error in connection ", localSockets[socket]);
    console.log("error main cleanup call hua ");
    // improvement needed here
    await cleanupRoom(socket.userId);
  });
}); // sockets connection

// Broadcast online count every 2 seconds to all connected clients
setInterval(async () => {
  try {
    const sessKeys = await redis.keys('sess:*');
    const count = sessKeys.length;
    io.emit('online_count', JSON.stringify({ count: count }));
  } catch (e) {
    console.error('Error broadcasting online count', e);
  }
}, 10000);

const PORT = process.env.PORT || 8081;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
