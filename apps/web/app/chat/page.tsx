import Chat from "@/app/components/Chat";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string | string[] }>;
}) {
  const params = await searchParams;
  const project = typeof params.project === "string" ? params.project : null;

  return (
    <main>
      <h1>Agent</h1>
      <p className="subtitle">
        One OpenRouter key, any model in the catalogue. The agent can create projects, edit plan
        milestones, and add goals on this machine.
      </p>
      <Chat project={project} />
    </main>
  );
}
