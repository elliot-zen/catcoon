import { useEffect, useRef, useState } from "react";
import { Check, Pencil } from "lucide-react";
import { activeRun, type Issue } from "../server/types";
import { useBackend } from "./ui-data";

export default function IssueDescription({
  issue,
  language,
}: {
  issue: Issue;
  language: "en" | "zh";
}) {
  const { action, load, data, busy } = useBackend();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const opened = useRef(false);
  const base = useRef({
    revision: issue.revision,
    description: issue.description,
  });
  const key = "issue-description-" + issue.id;
  const zh = language === "zh";
  const locked =
    data.runs.some((r) => r.issueId === issue.id && activeRun(r)) ||
    issue.sessions.some((s) => s.status === "busy" || s.status === "unknown");
  const blocked = issue.status === "Done" || locked;
  const reason =
    issue.status === "Done"
      ? zh
        ? "通过 Reopen 修改已完成的目标"
        : "Use Reopen to change a completed target"
      : locked
        ? zh
          ? "先停止当前执行，再修改正文"
          : "Stop the current execution before editing"
        : editing
          ? zh
            ? "保存正文（Ctrl / Cmd + Enter）"
            : "Save description (Ctrl / Cmd + Enter)"
          : zh
            ? "编辑正文"
            : "Edit description";

  useEffect(() => {
    if (editing && textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = textarea.current.scrollHeight + "px";
    }
  }, [draft, editing]);

  function open() {
    base.current = { revision: issue.revision, description: issue.description };
    setDraft(sessionStorage.getItem(key) ?? issue.description);
    opened.current = true;
    setEditing(true);
  }
  function cancel() {
    opened.current = false;
    sessionStorage.removeItem(key);
    setEditing(false);
  }
  async function save() {
    if (!opened.current || pending.current) return;
    if (draft === base.current.description) {
      cancel();
      return;
    }
    pending.current = true;
    setSaving(true);
    const content = draft;
    try {
      const result = await action("issue.update", {
        issueId: issue.id,
        revision: base.current.revision,
        description: content,
      });
      if (result && sessionStorage.getItem(key) === content)
        sessionStorage.removeItem(key);
      // Reload the current body after a conflict; reopening explicitly retries
      // the retained input against the revision the user can now review.
      if (!result) await load();
      opened.current = false;
      setEditing(false);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="relative mt-3 max-w-2xl pr-8 text-[13px] leading-6 text-muted-foreground">
      {editing ? (
        <textarea
          ref={textarea}
          autoFocus
          rows={1}
          aria-label={zh ? "Issue 正文" : "Issue description"}
          value={draft}
          disabled={saving}
          className="block min-h-6 w-full resize-none bg-transparent text-[13px] leading-6 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onChange={(e) => {
            setDraft(e.target.value);
            sessionStorage.setItem(key, e.target.value);
          }}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void save();
            }
          }}
        />
      ) : (
        <div
          data-testid="issue-description"
          className="whitespace-pre-wrap break-words"
        >
          {issue.description || (zh ? "添加正文…" : "Add description…")}
        </div>
      )}
      <button
        type="button"
        aria-label={
          editing
            ? zh
              ? "保存正文"
              : "Save description"
            : zh
              ? "编辑正文"
              : "Edit description"
        }
        title={reason}
        disabled={busy || saving || blocked}
        className="absolute right-0 top-0 inline-flex size-6 items-center justify-center rounded-full outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (editing ? void save() : open())}
      >
        {editing ? <Check size={14} /> : <Pencil size={14} />}
      </button>
    </div>
  );
}
