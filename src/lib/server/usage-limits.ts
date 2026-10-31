// Daily caps protect paid providers during traffic spikes. Set a limit to 0 to pause that work.
export function dailyLimit(name: string, fallback: number) {
  const configured = process.env[name];
  return configured && /^\d+$/.test(configured) && Number.isSafeInteger(Number(configured))
    ? Number(configured)
    : fallback;
}

export const onboardingLimits = (owner: string) => [
  { key: "onboarding:global", max: dailyLimit("ONBOARDING_DAILY_LIMIT", 3000) },
  { key: `onboarding:${owner}`, max: dailyLimit("ONBOARDING_ACCOUNT_DAILY_LIMIT", 150) },
];

export const voiceLimits = (owner: string) => [
  { key: "voice:global", max: dailyLimit("VOICE_DAILY_LIMIT", 500) },
  { key: `voice:${owner}`, max: dailyLimit("VOICE_ACCOUNT_DAILY_LIMIT", 40) },
];

export const signInEmailLimits = () => [
  { key: "sign-in-email:global", max: dailyLimit("SIGN_IN_EMAIL_DAILY_LIMIT", 500) },
];
