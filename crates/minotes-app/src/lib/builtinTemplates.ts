import { localDateKey, localTimeKey } from "./dates";

/**
 * Substitute template placeholders. Dates use the viewer's local calendar day,
 * matching the journal/sidebar convention.
 *
 * Supported: {{date}} → YYYY-MM-DD, {{time}} → HH:MM.
 */
export function applyTemplateVars(line: string, now: Date = new Date()): string {
  return line
    .replace(/\{\{date\}\}/g, localDateKey(now))
    .replace(/\{\{time\}\}/g, localTimeKey(now));
}

export interface Template {
  name: string;
  description: string;
  blocks: string[];
}

export const BUILTIN_TEMPLATES: Template[] = [
  {
    name: "Meeting Notes",
    description: "Structured meeting agenda with sections",
    blocks: [
      "# Meeting {{date}}",
      "## Attendees",
      "## Agenda",
      "## Discussion",
      "## Action Items",
      "TODO ",
      "## Follow-up",
    ],
  },
  {
    name: "Project Brief",
    description: "Project overview with goals and milestones",
    blocks: [
      "## Overview",
      "## Goals",
      "TODO ",
      "## Milestones",
      "## Resources",
      "## Risks",
    ],
  },
  {
    name: "Weekly Review",
    description: "Reflect on the past week and plan ahead",
    blocks: [
      "# Weekly Review — week of {{date}}",
      "## Wins this week",
      "## Challenges",
      "## Lessons learned",
      "## Next week priorities",
      "TODO ",
    ],
  },
  {
    name: "Bug Report",
    description: "Structured bug report template",
    blocks: [
      "## Summary",
      "## Steps to Reproduce",
      "1. ",
      "2. ",
      "3. ",
      "## Expected Behavior",
      "## Actual Behavior",
      "## Environment",
    ],
  },
  {
    name: "Daily Standup",
    description: "Quick daily update format",
    blocks: [
      "# Standup {{date}}",
      "## Yesterday",
      "DONE ",
      "## Today",
      "TODO ",
      "## Blockers",
    ],
  },
  {
    name: "Decision Log",
    description: "Record important decisions and reasoning",
    blocks: [
      "## Decision",
      "## Context",
      "## Options Considered",
      "## Chosen Option",
      "## Rationale",
    ],
  },
];
