import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv'

dotenv.config();

console.log("api key ", process.env.GEMINI_API_KEY);
// Gemini setup
export const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
export const GEMINI_MODEL_ID = 'gemini-2.5-flash'; // or 'gemini-2.5-flash' if enabled for you

// Bot / fallback config
export const BOT_RECENT_HISTORY_LIMIT = 20;   // last N messages
export const BOT_MIN_DELAY_MS = 1000;
export const BOT_MAX_DELAY_MS = 6000;

// Track bot-room inactivity in memory (per instance)
export const botRoomTimers = new Map(); // roomId -> timeoutId

