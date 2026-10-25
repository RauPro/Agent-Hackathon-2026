export const PROFILE_FIELDS = ["bio", "offers", "goalText"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export const PROFILE_QUESTIONS: Record<ProfileField, string> = {
  bio: "What is one project or problem you have worked on, and what was your part in it?",
  offers: "What is one specific thing you could help someone with, based on your experience?",
  goalText: "Who would you like to meet, and what would you like to work toward with them?",
};

// A conservative backstop for obvious filler, not a semantic quality score.
// The model separately evaluates specificity in the context of the conversation.
const genericWords = new Set(`i im ive id am a an the and or but to for of in on at
  with my me we our us you your it its is are be being have has do doing work working
  worked experience experienced professional professionals background person people
  things something anything everything stuff good great many much lots lot some
  very really more new all any other general generally various different interested
  interest interests passionate passion innovation innovative motivated motivation
  hard hardworking dedicated talented skills skill knowledge expertise help helping
  helpful offer offering share sharing learn learning grow growth explore exploring
  opportunities opportunity network networking connect connecting connections meet
  meeting collaborate collaborating collaboration collaborators business businesses
  tech technology technologies industry industries startup startups entrepreneur
  founder founders engineer engineers engineering software product products build
  building team teams job jobs role roles hire hiring customer customers client
  clients find finding looking seeking want like would could can will just get out
  make making open not no sure know yet whatever unsure dont dontknow tbd none
  as about from also into so that this well better success successful years year
  sf san francisco`.split(/\s+/));

export function basicProfileGaps(draft: Record<ProfileField, string>): ProfileField[] {
  return PROFILE_FIELDS.filter((field) => {
    const words = draft[field].toLowerCase().replace(/[’']/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
    return !words.some((word) => !genericWords.has(word) && !/^\d+$/.test(word));
  });
}
