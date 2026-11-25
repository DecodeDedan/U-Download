import { IconDownload, IconFolder, IconPaste, IconSearch } from "./icons";

const KIND_LABELS = {
  media: "Video page",
  file: "Direct file",
  torrent: "Torrent / FTP",
  search: "Search",
};

/**
 * One field for everything: paste a link of any kind, or type words to search.
 * The chip says which engine will take it before anything is pressed.
 */
export default function CommandBar({
  value,
  kind,
  busy,
  hint,
  folderLabel,
  canPickFolder,
  onChange,
  onSubmit,
  onPickFolder,
}) {
  const isSearch = kind === "search";
  const empty = value.trim() === "";

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) onChange(text.trim());
    } catch (error) {
      console.error("Clipboard is not available here:", error);
    }
  };

  const submit = (event) => {
    event.preventDefault();
    if (!empty && !busy) onSubmit();
  };

  return (
    <form className="command" onSubmit={submit} aria-label="Add a download">
      <div className="command__row">
        <label htmlFor="command-input" className="sr-only">Link or search words</label>
        <div className="command__field">
          <span className="command__glyph" aria-hidden="true">
            {isSearch && !empty ? <IconSearch size={18} /> : <IconDownload size={18} />}
          </span>
          <input
            id="command-input"
            data-testid="command-input"
            className="command__input"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Paste a video, file, torrent or magnet link, or search"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-describedby="command-hint"
          />
          {!empty && (
            <span className={`chip chip--${kind}`} data-testid="kind-chip">{KIND_LABELS[kind]}</span>
          )}
          <button type="button" className="icon-btn command__paste" onClick={paste} aria-label="Paste from clipboard" title="Paste">
            <IconPaste size={18} />
          </button>
        </div>
        <button
          type="submit"
          className="btn btn-primary command__go"
          disabled={empty || busy}
          aria-busy={busy}
          data-testid="command-go"
        >
          {isSearch ? <IconSearch size={18} /> : <IconDownload size={18} />}
          <span>{busy ? "Adding…" : isSearch ? "Search" : "Download"}</span>
        </button>
      </div>

      <div className="command__options">
        <button
          type="button"
          className="btn btn-sm btn-quiet command__folder"
          onClick={onPickFolder}
          disabled={!canPickFolder}
          title={folderLabel || "Choose folder"}
        >
          <IconFolder size={16} />
          <span className="truncate">{folderLabel || "Choose folder"}</span>
        </button>
      </div>
      <p id="command-hint" className={`command__hint ${hint?.tone ? `command__hint--${hint.tone}` : ""}`} role="status">
        {hint?.text || " "}
      </p>
    </form>
  );
}
