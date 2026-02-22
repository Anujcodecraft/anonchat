import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

export const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Best free model
export const GROQ_MODEL_ID = "llama-3.1-8b-instant";
