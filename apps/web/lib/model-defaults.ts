/**
 * The model the chat agent uses when nothing else is chosen.
 *
 * Gemini Flash 3.5 runs on the free tier and supports tool calling, so Slate's project-edit
 * tools (projects, goals, tasks, milestones) work with it out of the box.
 *
 * This module is imported by both the browser and the server, so it must stay free of Node
 * built-ins.
 */
export const DEFAULT_CHAT_MODEL = "gemini/gemini-3.5-flash";
