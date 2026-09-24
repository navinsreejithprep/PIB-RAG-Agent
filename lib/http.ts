export function publicErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("openai_api_key")) {
      return "OPENAI_API_KEY is not set on the server. Add it to .env.local locally or to the hosting provider's environment variables, then restart or redeploy.";
    }
    if (message.includes("api key") || message.includes("authentication") || message.includes("unauthorized")) {
      return "OpenAI authentication failed. Check OPENAI_API_KEY in .env.local.";
    }
    if (message.includes("rate limit") || message.includes("429")) {
      return "OpenAI rate limit reached. Wait a moment and try again.";
    }
    if (message.includes("timeout") || message.includes("timed out")) {
      return "The OpenAI request timed out. Try again with a smaller document or question.";
    }
  }
  return fallback;
}
