import { describe, expect, it } from "vitest";
import { rankPeople } from "../src/lib/domain/discovery";
import type { SharedProfile } from "../src/lib/domain/network";
import { validContext } from "./fixtures";

// Fictional profiles exercise explicit stated intent, not inferred commercial interest.
function person(name: string, bio: string, offers: string, goal: string, type: NonNullable<SharedProfile["goal"]>["type"] = "customers"): SharedProfile {
  return {
    id: name, name, revision: 1,
    profile: { name, bio, offers }, goal: { type, text: goal },
    trip: { ...validContext().trip, start: "2026-11-01", end: "2026-11-15" },
  };
}
const founder = () => person("Founder Demo",
  "Founder building construction software and AI agents for BIM coordination.",
  "A construction software product demo and experience shipping BIM automation.",
  "Meet VCs to explore investment for our construction AI product.");
const investor = () => person("Investor Demo",
  "Seed investor focused on construction technology startups.",
  "Investment feedback for founders building construction software.",
  "Meet founders and evaluate early-stage startups.", "collaborators");
const vendor = () => person("Product Demo",
  "Founder building BIM coordination tools for construction teams.",
  "A construction software pilot and hands-on BIM product expertise.",
  "Find contractors as design partners for BIM coordination pilots.");
const operator = () => person("Operator Demo",
  "BIM manager at a construction firm coordinating architectural deliverables.",
  "Feedback on construction workflows and BIM coordination problems.",
  "Evaluate BIM coordination tools for our construction projects.", "collaborators");
const rank = (a: SharedProfile, b: SharedProfile) => rankPeople(a, b, "2026-10-24");

describe("explicit reciprocal business goals", () => {
  it("matches fundraising with a stated investor's founder-discovery goal in both directions", () => {
    const a = founder(), b = investor();
    const forward = rank(a, b), reverse = rank(b, a);
    expect(forward).not.toBeNull();
    expect(reverse).not.toBeNull();
    expect(forward!.signals).toContain("construction / AEC");
    expect(forward!.benefits.you).toContain("fundraising");
    expect(reverse!.benefits.you).toContain("fundraising goal");
    expect(forward!.score).toBe(reverse!.score);
    expect(forward!.reasons.join(" ")).not.toMatch(/will invest|funding secured|committed/);
  });

  it("uses the stated domain without requiring it to be repeated in short goals", () => {
    const a = founder(), b = investor();
    a.goal!.text = "Meet VCs to explore investment for Converza.";
    b.goal!.text = "Find early-stage founders to evaluate investment opportunities.";
    expect(rank(a, b)?.signals).toContain("construction / AEC");
    b.profile!.bio = "I am an early-stage investor focused on AEC companies.";
    expect(rank(a, b)).not.toBeNull();
    b.profile!.bio = "I invest in construction technology startups.";
    expect(rank(a, b)).not.toBeNull();
  });

  it("can use a founder's explicit goal sector without claiming sector experience", () => {
    const a = founder(), b = investor();
    a.profile!.bio = "Software engineer building production AI agents.";
    a.profile!.offers = "Production AI engineering and TypeScript product feedback.";
    a.goal!.text = "Meet VCs to explore investment for Converza Construction AI.";
    const result = rank(a, b);
    expect(result).not.toBeNull();
    expect(result!.reasons).toContain("Shared focus: construction / AEC.");
    expect(result!.reasons.join(" ")).not.toMatch(/construction experience|Both profiles mention/);
  });

  it("matches customer discovery with an explicit relevant tool-evaluation goal", () => {
    const a = vendor(), b = operator();
    expect(rank(a, b)?.benefits.you).toContain("customers or design partners");
    expect(rank(b, a)?.benefits.you).toContain("tool to evaluate");
    expect(rank(a, b)?.reasons.join(" ")).not.toMatch(/will buy|budget|purchase authority|confirmed customer/);
  });

  it("requires reciprocal intent rather than merely a matching occupation", () => {
    const a = founder(), b = investor();
    b.goal!.text = "Find a founding engineer for my unrelated side project.";
    expect(rank(a, b)).toBeNull();
    const c = vendor(), d = operator();
    d.goal!.text = "Meet people and learn about the startup ecosystem.";
    expect(rank(c, d)).toBeNull();
    d.goal!.text = "Find customers and design partners for our construction tools.";
    expect(rank(c, d)).toBeNull();
  });

  it("does not infer investor identity from working with investors", () => {
    const a = founder(), b = investor();
    b.profile!.bio = "Software engineer building construction products with investors.";
    b.profile!.offers = "Construction product demos and introductions to founders.";
    expect(rank(a, b)).toBeNull();
  });

  it("does not match generic AI interests alone or an unrelated stated investment sector", () => {
    const a = founder(), b = investor();
    a.profile!.bio = "Founder building AI software.";
    a.profile!.offers = "A demo of an AI product.";
    a.goal!.text = "Raise funding for our AI product.";
    b.profile!.bio = "Seed investor interested in AI startups.";
    b.profile!.offers = "Feedback on AI startup investments.";
    expect(rank(a, b)).toBeNull();
    const genericVendor = vendor(), genericOperator = operator();
    genericVendor.profile!.bio = "Founder building AI software.";
    genericVendor.profile!.offers = "A demo of an AI product.";
    genericVendor.goal!.text = "Find design partners for AI software.";
    genericOperator.profile!.bio = "Operator interested in AI software.";
    genericOperator.profile!.offers = "Feedback on AI products.";
    genericOperator.goal!.text = "Evaluate AI software tools.";
    expect(rank(genericVendor, genericOperator)).toBeNull();
    const specificFounder = founder(), specificInvestor = investor();
    specificInvestor.goal!.text = "Evaluate healthcare startups for investment.";
    expect(rank(specificFounder, specificInvestor)).toBeNull();
    specificFounder.goal!.type = "collaborators";
    expect(rank(specificFounder, specificInvestor)).toBeNull();
    specificInvestor.profile!.bio = "Seed investor focused on healthcare software startups.";
    specificInvestor.profile!.offers = "Feedback on clinical software investment.";
    expect(rank(specificFounder, specificInvestor)).toBeNull();
  });

  it.each([
    "I am not raising funding for construction software.",
    "I do not want to meet VCs for investment in construction AI.",
    "I used to raise funding for construction software.",
    "I am looking for feedback rather than investment in construction AI.",
    "I want to meet VCs. I am not raising investment right now.",
    "Meet construction founders and avoid investors.",
    "My friend is looking for investors in construction AI; I want to meet customers.",
    "I might seek investment for construction AI if our current project fails.",
  ])("honors a negated or historical fundraising intention: %s", (goal) => {
    const a = founder(); a.goal!.text = goal;
    expect(rank(a, investor())).toBeNull();
  });

  it.each([
    ["Former seed investor in construction technology.", "I no longer offer investment feedback."],
    ["I am not an investor in construction companies.", "I do not invest in construction startups."],
  ])("honors a negated or historical investor role: %s", (bio, offers) => {
    const b = investor(); b.profile = { ...b.profile!, bio, offers };
    expect(rank(founder(), b)).toBeNull();
  });

  it("honors negated customer or evaluation intentions and accepts an explicit correction", () => {
    const a = vendor(), b = operator();
    a.goal!.text = "I am not seeking customers or design partners for construction software.";
    expect(rank(a, b)).toBeNull();
    a.goal!.text = "I am not hiring, but I am looking for design partners for BIM tools.";
    expect(rank(a, b)).not.toBeNull();
    b.goal!.text = "I am not evaluating construction tools or software.";
    expect(rank(a, b)).toBeNull();
    const investorWithRetraction = investor();
    investorWithRetraction.profile!.offers = "I no longer invest in construction companies.";
    expect(rank(founder(), investorWithRetraction)).toBeNull();
  });

  it("preserves date, city and authorized-field requirements", () => {
    const a = founder(), b = investor();
    b.trip = { ...b.trip!, start: "2026-12-01", end: "2026-12-10" };
    expect(rank(a, b)).toBeNull();
    b.trip = investor().trip;
    delete b.goal;
    expect(rank(a, b)).toBeNull();
    b.goal = investor().goal;
    delete b.profile;
    expect(rank(a, b)).toBeNull();
  });

  it("keeps contradictory named roles and negated hiring from matching", () => {
    const a = founder(), b = investor();
    a.goal = { type: "seeking_role", text: "Find a founding engineer role building construction AI agents." };
    b.goal = { type: "hiring", text: "Hire a sales director for construction AI software." };
    expect(rank(a, b)).toBeNull();
    b.goal.text = "I am not hiring a founding engineer for construction AI.";
    expect(rank(a, b)).toBeNull();
    b.goal.text = "I am not hiring, but I want to meet a founding engineer working on construction AI agents.";
    expect(rank(a, b)).toBeNull();
    b.goal.text = "I used to hire founding engineers. Now I want a founding engineer to review my construction AI agents.";
    expect(rank(a, b)).toBeNull();
  });

  it("does not confuse software architectural decisions with the construction sector", () => {
    const b = investor();
    b.profile!.bio = "Seed investor helping software teams make architectural decisions for distributed systems.";
    b.profile!.offers = "Feedback on architectural tradeoffs in software infrastructure.";
    expect(rank(founder(), b)).toBeNull();
  });

  it("does not let a shared technical topic override explicitly different sectors", () => {
    const a = founder(), b = investor();
    a.goal!.text = "Meet VCs for investment in our product.";
    b.profile!.bio = "Seed investor focused exclusively on healthcare AI agents.";
    b.profile!.offers = "Investment feedback on clinical AI agents.";
    expect(rank(a, b)).toBeNull();
    b.profile!.offers = "Experience with construction AI agents, but my current investment focus is healthcare.";
    expect(rank(a, b)).toBeNull();
    b.profile!.bio = "Seed investor focused on construction AI agents.";
    b.profile!.offers = "Investment feedback on construction software.";
    expect(rank(a, b)).not.toBeNull();
    b.goal!.text = "Avoid construction projects. Meet founders and evaluate startup investments.";
    expect(rank(a, b)).toBeNull();
  });
});

describe("technical exchanges across different goals", () => {
  const engineer = () => person("Engineer Demo",
    "Software engineer building production voice agents and agent infrastructure.",
    "Product engineering experience with voice agents, inference and session context.",
    "Find a founding engineer role working on voice agents and product engineering.", "seeking_role");
  const builder = () => person("Builder Demo",
    "Founder of a company building voice agents for hotel reservations.",
    "Can discuss voice agents for hotel workflows, inference and session context.",
    "Meet people building agents to learn about inference and session context, and explore technical partnerships.", "collaborators");

  it("proposes a reciprocal technical exchange without inventing hiring intent", () => {
    const a = engineer(), b = builder();
    const forward = rank(a, b), reverse = rank(b, a);
    expect(forward).not.toBeNull();
    expect(reverse).not.toBeNull();
    expect(forward!.signals).toContain("voice agents");
    expect(forward!.benefits.you).toContain("technical exchange");
    expect(reverse!.benefits.you).toContain("compare approaches");
    expect(`${forward!.reasons} ${JSON.stringify(forward!.benefits)} ${JSON.stringify(reverse!.benefits)}`)
      .not.toMatch(/hiring|job offer|investment|fundraising/);
  });

  it("requires explicit networking intent and reciprocal specific topic relevance", () => {
    const a = engineer(), b = builder();
    b.goal!.text = "Improve our voice agents and hotel operations.";
    expect(rank(a, b)).toBeNull();
    b.goal!.text = builder().goal!.text;
    a.goal!.text = "Find a founding engineer role in payment systems.";
    expect(rank(a, b)).toBeNull();
    a.goal!.text = engineer().goal!.text;
    b.profile!.bio = "Founder building AI software.";
    b.profile!.offers = "Product feedback on AI software.";
    expect(rank(a, b)).toBeNull();
  });

  it("does not route commercial, negated or conditional goals through technical networking", () => {
    const a = engineer(), b = builder();
    b.goal!.text = "Meet agent builders for technical partnerships and find customers for our voice agents.";
    expect(rank(a, b)).toBeNull();
    b.goal!.text = "Avoid technical partnerships. Meet people building voice agents.";
    expect(rank(a, b)).toBeNull();
    b.goal!.text = "I might meet people building voice agents if I decide to explore partnerships.";
    expect(rank(a, b)).toBeNull();
    b.goal!.text = builder().goal!.text;
    a.goal!.text = "Only seeking paid roles working on voice agents.";
    expect(rank(a, b)).toBeNull();
    a.goal!.text = "Find a founding engineer role with voice agents. I am not interested in networking.";
    expect(rank(a, b)).toBeNull();
  });

  it("keeps other goal combinations and non-overlapping trips out of this path", () => {
    const a = engineer(), b = builder();
    a.goal!.type = "customers";
    expect(rank(a, b)).toBeNull();
    a.goal!.type = "seeking_role";
    b.trip = { ...b.trip!, start: "2026-12-01", end: "2026-12-10" };
    expect(rank(a, b)).toBeNull();
  });

  it("does not let prior sector experience override a current explicit exclusion", () => {
    const a = engineer(), b = builder();
    a.profile!.offers += " Experience with construction voice agents.";
    b.profile!.offers += " Experience with construction voice agents.";
    b.goal!.text = "Avoid construction projects. Meet people building voice agents to explore technical partnerships.";
    expect(rank(a, b)).toBeNull();
  });
});
