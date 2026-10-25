export const VOICES = ["Ava (Premium)", "Ava", "Samantha"];
export const SPEECH_RATE = 175;

// lead: seconds from scene start to the first narration line. min: minimum scene length.
export const SCENES = [
  {
    id: "hook", lead: 1.6, min: 9,
    lines: [
      "Your coding agent spent an hour on a bug.",
      "Then the context was compacted.",
      "Now it starts from zero."
    ]
  },
  {
    id: "rework", lead: 1.8, min: 8,
    lines: [
      "It reads the same files again.",
      "It tries the fix that already failed."
    ]
  },
  {
    id: "idea", lead: 0.9, min: 12,
    lines: [
      "Agentpack keeps the task state in your repo.",
      "Not the chat: the goal, the decisions, the dead ends, the evidence, and the next step."
    ]
  },
  {
    id: "record", lead: 0.8, min: 15,
    lines: ["While the agent works, it records only what is worth keeping."]
  },
  {
    id: "continue", lead: 0.8, min: 13,
    lines: [
      "Next day. New session. Empty context.",
      "One call, and the agent knows where the task stands."
    ]
  },
  {
    id: "clients", lead: 0.8, min: 7,
    lines: ["Any MCP client can continue: Claude Code, Codex, or Cursor."]
  },
  {
    id: "trust", lead: 0.8, min: 8,
    lines: [
      "Plain files. No cloud.",
      "A gate that warns when the agent leaves its task."
    ]
  },
  {
    id: "cta", lead: 0.6, min: 11,
    lines: ["Three commands, and your next session starts where the last one stopped."]
  }
];

export const GAPS = { withinScene: 0.25, tail: 0.7, tailLast: 3.0 };
