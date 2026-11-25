const ONBOARDING_KEY = 'minotes-onboarding-complete';

export function isOnboardingComplete(): boolean {
  return localStorage.getItem(ONBOARDING_KEY) === 'true';
}

export function markOnboardingComplete(): void {
  localStorage.setItem(ONBOARDING_KEY, 'true');
}

export const TUTORIAL_BLOCKS = [
  "Welcome to MiNotes! This is a block. Each bullet point is an independent unit of content.",
  "Press **Enter** to create a new block below this one. Try it!",
  "Press **Backspace** at the start of an empty block to delete it.",
  "Type **[[** to link to another page. Try typing [[My First Page]]",
  "Press **/** for slash commands — insert headings, code blocks, tables, and more.",
  "Press **Ctrl+Enter** to cycle through TODO → DOING → DONE states.",
  "Use **Ctrl+K** to search everything, or type **>** for commands.",
  "Press **Ctrl+J** to jump to today's journal anytime.",
  "Press **Ctrl+,** to open Settings. You're ready to go!",
];
