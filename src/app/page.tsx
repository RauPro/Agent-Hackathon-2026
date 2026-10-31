import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { currentAccount } from "@/lib/server/current-account";
import "./landing.css";

export const dynamic = "force-dynamic";

const steps = [
  {
    title: "Tell Sidekick why you're in SF",
    text: "A short chat captures your goal, your trip dates and what you can offer. You confirm the profile before anything is shared.",
  },
  {
    title: "Get the right events and people",
    text: "Sidekick searches live SF events against your goal and explains why each one is worth your time.",
  },
  {
    title: "Your agent talks to theirs",
    text: "When you connect with someone, your agents check fit and propose a 30-minute meeting. Both people approve before anything is booked.",
  },
];

const sample = [
  { who: "Your agent", text: "Alex is hiring a founding engineer for an AI agents startup. Maya shipped agent tooling at two seed companies." },
  { who: "Maya's agent", text: "Maya is interested. She is free Thursday afternoon near SoMa." },
  { who: "Your agent", text: "Proposing Thursday 3:30 PM at a café on 2nd Street. Waiting for Alex to approve." },
];

export default async function Page() {
  if (await currentAccount()) redirect("/onboarding");
  return (
    <>
      <header className="site-header">
        <Brand />
        <Link className="text-button" href="/login">
          Sign in
        </Link>
      </header>
      <main className="landing">
        <section className="landing-hero">
          <p className="eyebrow">SAN FRANCISCO · AI NETWORKING AGENT</p>
          <h1>Meet the people who matter while you&apos;re in SF.</h1>
          <p className="landing-lead">
            SF Sidekick learns your goal, finds the events worth attending and
            lets your agent coordinate meetings with other people&apos;s agents.
            You approve every step.
          </p>
          <div className="landing-actions">
            <Link className="primary-button" href="/register">
              Get started
            </Link>
            <a className="secondary-button" href="#how-it-works">
              How it works
            </a>
          </div>
        </section>
        <section
          className="landing-sample"
          aria-labelledby="sample-title"
        >
          <h2 id="sample-title">Example agent conversation</h2>
          <p className="landing-muted">Sample data for illustration.</p>
          <ol>
            {sample.map((line, index) => (
              <li key={index}>
                <strong>{line.who}</strong>
                <span>{line.text}</span>
              </li>
            ))}
          </ol>
        </section>
        <section id="how-it-works" aria-labelledby="steps-title">
          <h2 id="steps-title">How it works</h2>
          <ol className="landing-steps">
            {steps.map((step, index) => (
              <li key={step.title}>
                <span className="landing-step-number">{index + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>
        <section aria-labelledby="control-title" className="landing-control">
          <h2 id="control-title">You stay in control</h2>
          <ul>
            <li>Sign in with a one-time code sent to your email.</li>
            <li>Nothing is shared with a connection until you allow it.</li>
            <li>Meetings are booked only after both people approve.</li>
            <li>
              Google Calendar is read only for busy times, never event details.
            </li>
            <li>
              Delete your account and data at any time.{" "}
              <Link href="/privacy">Read the privacy notice</Link>.
            </li>
          </ul>
          <Link className="primary-button" href="/register">
            Get started
          </Link>
        </section>
      </main>
      <footer className="landing-footer">
        <Link href="/privacy">Privacy</Link>
        <a href="https://github.com/RauPro/Agent-Hackathon-2026">GitHub</a>
      </footer>
    </>
  );
}
