// SIDEKICK_AI_PAUSED=1 disables every paid model and search call without a redeploy of code.
export function aiPaused() {
  return process.env.SIDEKICK_AI_PAUSED === "1";
}

export function openAIKey() {
  return aiPaused() ? undefined : process.env.OPENAI_API_KEY?.trim() || undefined;
}

export function exaKey() {
  return aiPaused() ? undefined : process.env.EXA_API_KEY?.trim() || undefined;
}
