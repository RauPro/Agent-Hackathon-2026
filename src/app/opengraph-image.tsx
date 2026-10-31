import { ImageResponse } from "next/og";

export const alt =
  "SF Sidekick: meet the people who matter while you're in San Francisco";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          background: "#f8f8f5",
          color: "#20201e",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 64,
              height: 64,
              background: "#20201e",
              borderRadius: 8,
            }}
          />
          <div style={{ fontSize: 40 }}>SF Sidekick</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 76, lineHeight: 1.1, letterSpacing: -2 }}>
            Meet the people who matter while you&apos;re in SF.
          </div>
          <div style={{ fontSize: 32, color: "#62625d" }}>
            Your AI agent finds events and coordinates meetings with other
            agents. You approve every step.
          </div>
        </div>
      </div>
    ),
    size,
  );
}
