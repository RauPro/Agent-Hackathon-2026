import Link from "next/link";
import { Brand } from "@/components/brand";
import "../landing.css";

export const metadata = { title: "Privacy · SF Sidekick" };

export default function Page() {
  return (
    <>
      <header className="site-header">
        <Link href="/" aria-label="SF Sidekick home">
          <Brand />
        </Link>
      </header>
      <main className="privacy">
        <h1>Privacy notice</h1>
        <p>
          SF Sidekick is an experimental project. This notice explains what it
          stores and how to remove it.
        </p>
        <h2>What we store</h2>
        <ul>
          <li>Your email address, used to sign in with one-time codes.</li>
          <li>
            The profile you confirm in chat: name, bio, goal, what you offer
            and your San Francisco trip dates, plus the onboarding chat itself.
          </li>
          <li>
            Connections, sharing permissions, agent conversations and meeting
            proposals you create in the network.
          </li>
          <li>
            If you connect Google Calendar: encrypted access tokens, calendar
            names and busy times for your trip window. Event titles and details
            are not stored.
          </li>
        </ul>
        <h2>Who processes it</h2>
        <p>
          Chat messages and profile details are sent to OpenAI to generate
          replies and match events. Event searches are sent to Exa. Sign-in
          emails are delivered by Resend. The app and database are hosted on
          Vercel and Turso. Google Calendar is used only after you connect it.
        </p>
        <h2>What other people see</h2>
        <p>
          A connection sees only the profile details you allow, and agents share
          only proposed meeting times, never your calendar events.
        </p>
        <h2>Deleting your data</h2>
        <p>
          Open the account menu and choose <strong>Delete account</strong>. This
          removes your profile, chat, connections, agent conversations,
          meetings and calendar tokens, and revokes Google access. Calendar
          invitations already sent to other people remain in their calendars.
        </p>
        <h2>Contact</h2>
        <p>
          Questions or deletion requests:{" "}
          <a href="https://github.com/RauPro/Agent-Hackathon-2026/issues">
            open an issue on GitHub
          </a>
          .
        </p>
      </main>
    </>
  );
}
