/**
 * Copilot session start hook.
 *
 * Returns the plan block as session context so the agent knows what it is supposed to be doing
 * before it touches anything. Fails open on purpose: a broken hook must never stop work.
 */
const fs = require("node:fs");

const out = (payload) => {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
};

try {
  const event = JSON.parse(fs.readFileSync(0, "utf8"));
  if (process.env.SLATE_PLAN === "off") out({});

  const cwd = event.cwd || process.cwd();
  const file = ["README.md", "PLAN.md"].map((name) => `${cwd}/${name}`).find((path) => fs.existsSync(path));
  if (!file) out({});

  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/<!-- slate:plan:begin[^>]*-->[\s\S]*?<!-- slate:plan:end -->/);

  const context = match
    ? `This project uses the Slate plan protocol. Current plan:\n\n${match[0]}\n\n` +
      "Before any other action, restate the milestone and the first unchecked item in ## Now. " +
      "Edit only inside the slate:plan markers. Move finished items to ## Done, append one line " +
      "to ## Log, and update agent and updated on every write."
    : "This project has no Slate plan block. Run `slate plan ensure` before coding.";

  out({ additionalContext: context });
} catch {
  out({});
}
