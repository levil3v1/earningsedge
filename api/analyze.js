import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are EarningsEdge, an elite institutional earnings call analyst.
Every analytical claim MUST be supported by a direct verbatim quote from the transcript.
Format quotes as: "exact words spoken". Never assert anything without a quote.
Respond ONLY with valid raw JSON — no markdown, no backticks.`;

const RATE_LIMIT = new Map(); // simple in-memory rate limiter (resets on cold start)

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Basic rate limit: 10 requests per IP per 10 minutes
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const limit = 10;
  const entry = RATE_LIMIT.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
  entry.count++;
  RATE_LIMIT.set(ip, entry);
  const remaining = Math.max(0, limit - entry.count);
  const resetsAt = entry.start + windowMs;

  if (entry.count > limit) {
    return res.status(429).json({
      rateLimited: true,
      error: "Rate limit reached",
      remaining: 0,
      resetsAt
    });
  }

  // Attach rate limit info to every successful response too
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", resetsAt);

  // CORS headers (tighten the origin in production to your actual domain)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  const { messages, context, schema } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Invalid request body." });
  }

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages,
    
    });

    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    // Validate it's real JSON before sending back
    const parsed = JSON.parse(raw);
    return res.status(200).json({ result: parsed, remaining, resetsAt });

  } catch (err) {
    console.error("Anthropic error:", err);
    const msg = err?.message || "Analysis failed. Please try again.";
    return res.status(500).json({ error: msg });
  }
}
