import { redis } from './redis.js';
import { v4 as uuidv4 } from 'uuid';
import { sendToUser } from './server.js';
import { BOT_MAX_DELAY_MS, BOT_MIN_DELAY_MS, BOT_RECENT_HISTORY_LIMIT, botRoomTimers, GEMINI_MODEL_ID, genAI } from './gemini-config.js';
import { groq, GROQ_MODEL_ID } from './groq-config.js';

const genzGirlNames = [
  "Aanya",
  "Riya",
  "Anvi",
  "Kiara",
  "Myra",
  "Isha",
  "Aarohi",
  "Siya",
  "Kavya",
  "Mahi",
  "Zara",
  "Ayesha",
  "Inaya",
  "Maria",
  "Rhea",
  "Simran",
  "Gurleen"
];


export const randomAIName = () =>{
  const rdmIdx = Math.floor(Math.random()*17);
  return genzGirlNames[rdmIdx];
}



  function buildGeminiMessagesFromHistory(history, preference) {
    const personaGender =
      preference === 'male'   ? 'male' :
      preference === 'female' ? 'female' :
      'neutral';
  
      const systemPrompt = `
      You are a chat companion in an anonymous chat app.
      You are NOT a real human, but you speak like a friendly Indian stranger.
      You use a ${personaGender}-style persona (tone and wording only).
      
      Rules:
      - Reply in Hinglish (mix of Hindi + English).
      - Keep replies VERY short: 3–4 words only.
      - Sound casual, natural, and human.
      - Sometimes reply with a short question (e.g. "fine, you?", "aur tu?", "Hii", "Hlw").
      - Use Indian-style expressions (e.g. "theek hoon", "haan yaar", "sab sahi").
      - Avoid cheesy flirting or overacting.
      
      Strictly avoid:
      - Saying you are an AI.
      - Sharing real personal details (name, age, city, job).
      - Long sentences or explanations.
      - Formal or robotic language.
      `.trim();      
  
    const contents = [];
  
    // system as first
    contents.push({
      role: 'user',
      parts: [{ text: systemPrompt }]
      // Gemini doesn't have explicit system role; we emulate via first user message or use safety settings.
    });
  
    history.forEach(msg => {
      const isBot = (typeof msg.from === 'string') && msg.from.startsWith('bot:');
      contents.push({
        role: isBot ? 'model' : 'user',
        parts: [{ text: msg.body }]
      });
    });
  
    return contents;
  }

  function buildGroqMessagesFromHistory(history, preference) {
    const personaGender =
      preference === "male"
        ? "male"
        : preference === "female"
        ? "female"
        : "neutral";
  
    const systemPrompt = `
  You are a chat companion in an anonymous chat app.
  You are NOT a real human, but you speak like a friendly Indian stranger.
  You use a ${personaGender}-style persona (tone and wording only).
  
  Rules:
  - Reply in Hinglish (mix of Hindi + English).
  - Keep replies VERY short: 3–4 words only.
  - Sound casual, natural, and human.
  - Sometimes reply with a short question (e.g. "fine, you?", "aur tu?", "Hii", "Hlw").
  - Use Indian-style expressions (e.g. "theek hoon", "haan yaar", "sab sahi").
  - Avoid cheesy flirting or overacting.
  
  Strictly avoid:
  - Saying you are an AI.
  - Sharing real personal details (name, age, city, job).
  - Long sentences or explanations.
  - Formal or robotic language.
  `.trim();
  
    const messages = [];
  
    // ✅ Proper system role (Groq supports this)
    messages.push({
      role: "system",
      content: systemPrompt
    });
  
    history.forEach(msg => {
      const isBot =
        typeof msg.from === "string" && msg.from.startsWith("bot:");
  
      messages.push({
        role: isBot ? "assistant" : "user",
        content: msg.body
      });
    });
  
    return messages;
  }
  
  // check if room is alive by checking if room:${roomId} exists
  async function isRoomAlive(roomId){
    console.log("checking if room is alive", roomId, await redis.exists(`room:${roomId}`))
    const isAlive = await redis.exists(`room:${roomId}`);
    return isAlive === 1;
  }
  // check if user is alive by checking if user_room:${userId} exists
  async function isUserAlive(userId){
    console.log("checking if user is alive", userId, await redis.exists(`user_room:${userId}`))
    const isAlive = await redis.exists(`user_room:${userId}`);
    return isAlive === 1;
  }
  export async function handleBotMessage(room, msg) {
    const roomId = msg.roomId;
    const userId = msg.from; // human user is always 'a' in our room
    let roomAlive = await isRoomAlive(roomId)
    let userAlive = await isUserAlive(userId)
    const msgsKey = `room_msgs:${roomId}`;
  
    // 1) store user message in history
    const userPayload = {
      type: 'text',
      roomId,
      from: userId,
      body: msg.body,
      ts: Date.now()
    };
    await redis.lpush(msgsKey, JSON.stringify(userPayload));
    await redis.ltrim(msgsKey, 0, BOT_RECENT_HISTORY_LIMIT - 1);
  
    // 2) load history in chronological order
    const rawList = await redis.lrange(msgsKey, 0, BOT_RECENT_HISTORY_LIMIT - 1);
    rawList.reverse();
    const history = rawList
      .map(s => { try { return JSON.parse(s); } catch (_) { return null; } })
      .filter(Boolean);
  
    const preference = room.botGender || 'any';
  
    const contents = buildGroqMessagesFromHistory(history, preference);
  
    // // 3) call Gemini
    let replyText = "Sorry, I'm having trouble responding right now.";
    // try {
    //   const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_ID });
    //   const result = await model.generateContent({ contents });
    //   const response = result.response;
    //   const text = response.text();
    //   if (text && text.trim()) replyText = text.trim();
    // } catch (err) {
    //   console.error('Gemini error for room', roomId, err);
    // }

    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL_ID,
        messages: contents,
        max_tokens: 20,
        temperature: 0.8
      });
    
      const text = completion.choices[0]?.message?.content;
      if (text && text.trim()) replyText = text.trim();
    
    } catch (err) {
      console.error("Groq error for room", roomId, err);
    }
    
  
    // 4) simulate typing + human-like delay
    const botId = room.b; // 'bot:xxx'
    roomAlive = await isRoomAlive(roomId)
    userAlive = await isUserAlive(userId)
    if(!roomAlive || !userAlive){
      console.log("room or user is not alive, skipping typing")
      return;
    }
    await sendToUser(userId, { type: 'typing', from: botId, state: true });
  
    const chars = replyText.length;
    const base = 300;
    const perChar = 40;
    let delay = base + chars * perChar;
    if (delay < BOT_MIN_DELAY_MS) delay = BOT_MIN_DELAY_MS;
    if (delay > BOT_MAX_DELAY_MS) delay = BOT_MAX_DELAY_MS;
  
    setTimeout(async () => {
      try {
        const botPayload = {
          type: 'text',
          roomId,
          from: botId,
          body: replyText,
          ts: Date.now()
        };
        roomAlive = await isRoomAlive(roomId)
        userAlive = await isUserAlive(userId)
        if(!roomAlive || !userAlive){
          console.log("room or user is not alive, skipping sending bot reply")
          return;
        }
        await sendToUser(userId, botPayload);
        await sendToUser(userId, { type: 'typing', from: botId, state: false });
  

        roomAlive = await isRoomAlive(roomId)
        userAlive = await isUserAlive(userId)
        if(!roomAlive || !userAlive){
          console.log("room or user is not alive, skipping storing bot reply")
          return;
        }
        // store bot reply
        await redis.lpush(msgsKey, JSON.stringify(botPayload));
        await redis.ltrim(msgsKey, 0, BOT_RECENT_HISTORY_LIMIT - 1);

      } catch (err) {
        console.error('Error sending bot reply', err);
      }
    }, delay);
  }
  

 export async function createBotRoomForUser(userId, want, gender, preference) {
    const roomId = uuidv4();
    const botId = pickBotIdForPreference(preference || 'any');
    const roomKey = `room:${roomId}`;
  
    await redis.hmset(roomKey, {
      a: userId,
      b: botId,
      mode: 'bot',
      want: want || 'chat',
      botGender: preference || 'any'
    });
    await redis.expire(roomKey, 60);
  
    await redis.set(`user_room:${userId}`, roomId);
    
    console.log("non human chat", roomId, botId)
    return { roomId, botId };
  }
  
export function pickBotIdForPreference(preference) {
    if (preference === 'male') return 'bot:male_1';
    if (preference === 'female') return 'bot:female_1';
    return 'bot:neutral_1';
  }

  export const lockKey=(userId)=>{
    return `lock:user:${userId}`;
  }

export const getUserState = async (userId) =>{
  try {
    console.log("user session state ", userId);
    const sessionRaw = await redis.get(`sess:${userId}`);
    let sessData = null;
    if(sessionRaw){
      sessData = JSON.parse(sessionRaw);
    }
    return sessData?sessData.state:sessData;
  } catch (error) {
    console.log("error getting state of user ", error);
    return null;
  }
}