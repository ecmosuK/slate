/**
 * Translating the model ids Slate uses internally into the ids the local opencode CLI expects.
 *
 * Slate's catalogue mixes models from three sources (opencode, gemini, openrouter), each with its
 * own id scheme. The agent chat runs every model through the opencode CLI, which only understands
 * opencode's `provider/model` form (provider ∈ google, openai, opencode, openrouter). So the
 * ids have to be mapped before they reach `opencode run --model`.
 *
 *   opencode/<id>            -> opencode/<id>                 (already opencode's own id)
 *   gemini/<id>              -> google/<id>                   (opencode's google provider)
 *   openrouter/free          -> openrouter/openrouter/free     (opencode's openrouter provider)
 *   <vendor>/<model>         -> openrouter/<vendor>/<model>    (OpenRouter ids need the prefix)
 */
export function toOpencodeModelId(id: string): string {
  if (id.startsWith("opencode/")) return id;
  if (id.startsWith("gemini/")) return `google/${id.slice("gemini/".length)}`;
  if (id.startsWith("openrouter/")) {
    // Slate's openrouter ids never start with openrouter/ (they are OpenRouter's own ids, which
    // already carry a vendor prefix like google/gemma-4-26b...). The special "openrouter/free"
    // router needs an extra prefix because opencode's openrouter provider stores it under that name.
    if (id === "openrouter/free") return "openrouter/openrouter/free";
    return id;
  }
  // OpenRouter catalogue ids (org/model:free, or openrouter/free handled above).
  return `openrouter/${id}`;
}
