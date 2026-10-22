/**
 * The built-in templates. Same outline format as user templates (lib/templates.ts):
 * one block per line, two spaces of indentation per level, `{{blank}}` an empty
 * block, `{{cursor}}` where the caret goes, `{{date}}` / `{{time}}` / `{{title}}`.
 */
export interface BuiltinTemplate {
  name: string;
  description: string;
  content: string;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    name: "Meeting Notes",
    description: "Attendees, agenda, notes and action items",
    content: [
      "## Meeting {{date}}",
      "  **Attendees**",
      "    {{cursor}}",
      "  **Agenda**",
      "    {{blank}}",
      "  **Notes**",
      "    {{blank}}",
      "  **Action items**",
      "    TODO ",
    ].join("\n"),
  },
  {
    name: "Project Brief",
    description: "Goals, milestones, resources and risks",
    content: [
      "## Overview",
      "  {{cursor}}",
      "## Goals",
      "  TODO ",
      "## Milestones",
      "  {{blank}}",
      "## Resources",
      "  {{blank}}",
      "## Risks",
      "  {{blank}}",
    ].join("\n"),
  },
  {
    name: "Weekly Review",
    description: "Wins, challenges and next week's priorities",
    content: [
      "## Weekly review — week of {{date}}",
      "  **Wins**",
      "    {{cursor}}",
      "  **Challenges**",
      "    {{blank}}",
      "  **Lessons learned**",
      "    {{blank}}",
      "  **Next week**",
      "    TODO ",
    ].join("\n"),
  },
  {
    name: "Bug Report",
    description: "Steps to reproduce, expected and actual behaviour",
    content: [
      "## Summary",
      "  {{cursor}}",
      "## Steps to reproduce",
      "  1. ",
      "## Expected behaviour",
      "  {{blank}}",
      "## Actual behaviour",
      "  {{blank}}",
      "## Environment",
      "  {{blank}}",
    ].join("\n"),
  },
  {
    name: "Daily Standup",
    description: "Yesterday, today and blockers",
    content: [
      "## Standup {{date}}",
      "  **Yesterday**",
      "    {{cursor}}",
      "  **Today**",
      "    TODO ",
      "  **Blockers**",
      "    {{blank}}",
    ].join("\n"),
  },
  {
    name: "Decision Log",
    description: "A decision with its context, options and reasons",
    content: [
      "## Decision",
      "  {{cursor}}",
      "  **Context**",
      "    {{blank}}",
      "  **Options considered**",
      "    {{blank}}",
      "  **Chosen option**",
      "    {{blank}}",
      "  **Rationale**",
      "    {{blank}}",
    ].join("\n"),
  },
];
