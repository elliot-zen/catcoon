import { eventNames, zh } from "./i18n";
import { groupActivity, type ActivityEntry } from "./activity";
import DirectoryField, {
  Backend,
  useBackend,
  useData,
  useSpec,
  time,
  relative,
  filesPayload,
} from "./ui-data";
import { useDraft } from "./api";
import type {
  Event as RelayEvent,
  Request as RelayRequest,
} from "../server/types";
import {
  Children,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import {
  Activity,
  Archive,
  ArrowUp,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Folder,
  GitBranch,
  Inbox,
  LayoutList,
  Layers3,
  ListFilter,
  Languages,
  Maximize2,
  Minimize2,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Paperclip,
  Plus,
  Search,
  Sparkles,
  Settings,
  SlidersHorizontal,
  Square,
  SquarePen,
  Sun,
  UserRound,
  ShieldCheck,
  X,
} from "lucide-react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "ghost" | "outline" | "default";
  size?: "sm" | "icon";
  layout?: "inline" | "grid";
};

function Button({
  className = "",
  variant = "ghost",
  size = "sm",
  layout = "inline",
  ...props
}: ButtonProps) {
  const variants = {
    ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
    outline:
      "border border-border bg-background text-foreground hover:bg-muted",
    default: "bg-foreground text-background hover:bg-foreground/90",
  };
  const sizes = {
    sm: "h-8 rounded-md px-2.5 text-xs",
    icon: "size-8 rounded-full",
  };

  return (
    <button
      className={`${layout === "grid" ? "grid" : "inline-flex items-center justify-center gap-1.5"} font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

function Avatar({
  children,
  tone = "dark",
}: {
  children: ReactNode;
  tone?: "dark" | "green" | "blue" | "violet";
}) {
  const tones = {
    dark: "bg-zinc-800 text-white",
    green: "bg-emerald-600 text-white",
    blue: "bg-blue-600 text-white",
    violet: "bg-violet-600 text-white",
  };

  return (
    <span
      className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function Property({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2 text-[13px]">
      <span className="text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Event({
  avatar,
  tone,
  children,
  initiallyCollapsed = false,
  activityId,
}: {
  avatar?: ReactNode;
  tone?: "dark" | "green" | "blue" | "violet";
  children: ReactNode;
  initiallyCollapsed?: boolean;
  activityId?: string;
}) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const content = Children.toArray(children);

  return (
    <div
      data-activity-id={activityId}
      className="relative flex items-start gap-3 px-2 pb-3 text-xs text-muted-foreground"
    >
      <span className="absolute -bottom-1 left-[18px] top-5 w-px bg-border" />
      {avatar ? (
        <Avatar tone={tone}>{avatar}</Avatar>
      ) : (
        <Circle size={14} className="shrink-0 text-zinc-400" />
      )}
      <div className="min-w-0 flex-1 leading-5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">{content[0]}</div>
          <Button
            size="icon"
            className="size-6"
            aria-label={collapsed ? "Expand event" : "Collapse event"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((current) => !current)}
          >
            <ChevronRight
              size={13}
              className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
            />
          </Button>
        </div>
        {!collapsed && content.slice(1)}
      </div>
    </div>
  );
}

function activityName(type: string, language: "en" | "zh") {
  return language === "zh"
    ? zh[type] || eventNames[type] || type
    : eventNames[type] || type;
}

function ActivityRecord({
  event: e,
  language,
  nested = false,
}: {
  event: RelayEvent;
  language: "en" | "zh";
  nested?: boolean;
}) {
  const { data } = useBackend();
  return (
    <div className={nested ? "mt-3" : ""}>
      {nested && (
        <div className="text-xs text-muted-foreground">
          {e.source} {activityName(e.type, language)} · {time(e.at)}
        </div>
      )}
      <div className="mt-0.5 whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
        {e.text}
      </div>
      {e.type === "attachment.created" && (
        <a
          className="text-xs text-blue-600"
          href={
            "/api/attachments/" +
            (e.data as { attachmentId: string }).attachmentId
          }
        >
          {e.text}
        </a>
      )}
      {e.type === "artifact.published" &&
        data.artifacts
          .filter(
            (a) =>
              a.issueId === e.issueId &&
              a.id === (e.data as { artifactId?: string })?.artifactId,
          )
          .map((a) => (
            <div
              key={a.id}
              className="mt-3 rounded-lg border border-border bg-card p-4 text-[13px]"
            >
              <div>
                {a.title} · {a.version.slice(0, 12)}
              </div>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
                {a.content}
              </pre>
            </div>
          ))}
    </div>
  );
}

function RunStream({ runId }: { runId: string }) {
  const { streamItems } = useBackend();
  return (
    <>
      {(streamItems[runId] || []).map((item) => (
        <div key={item.itemKey} className="mt-3">
          <div className="text-xs text-muted-foreground">
            {item.kind === "tool"
              ? item.metadata.title
              : item.kind === "thinking"
                ? "Thinking"
                : "Answer"}
            {item.kind === "tool" && " · " + item.status}
          </div>
          {item.kind === "tool" && item.metadata.parameters && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px]">
              {typeof item.metadata.parameters === "string"
                ? item.metadata.parameters
                : JSON.stringify(item.metadata.parameters, null, 2)}
            </pre>
          )}
          {item.content && (
            <pre
              className={
                "mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words " +
                (item.kind === "answer"
                  ? "text-[13px] text-foreground"
                  : "text-[11px] text-muted-foreground")
              }
            >
              {item.content}
            </pre>
          )}
          {item.metadata.exitCode !== undefined && (
            <div className="text-xs text-muted-foreground">
              Exit {item.metadata.exitCode}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
function actionDescription(request: RelayRequest) {
  const a = request.action;
  if (!a) return "";
  if (a.type === "native") return a.method;
  if (a.type === "review") return a.description;
  if (a.type === "final")
    return "Accept the reviewed goal and evidence as Done";
  return (
    (a.type === "approve_spec_and_upgrade"
      ? "Approve version and upgrade listed Worktrees"
      : "Approve the fixed version") +
    " · " +
    a.specVersionId
  );
}

function ActivityRow({
  entry,
  language,
}: {
  entry: ActivityEntry;
  language: "en" | "zh";
}) {
  const { data, streamItems } = useBackend();
  const first = entry.kind === "event" ? entry.event : entry.events[0];
  const source =
    entry.kind === "run" ? entry.run.snapshot.agentName : first.source;
  let type = first.type;
  if (entry.kind === "run")
    type =
      "run." +
      ((
        { starting: "scheduled", running: "started" } as Record<string, string>
      )[entry.run.status] || entry.run.status);
  return (
    <Event
      avatar={source[0] || "S"}
      tone={
        source === "Triage" ? "violet" : source === "Codex" ? "green" : "dark"
      }
      initiallyCollapsed={entry.kind === "run"}
      activityId={entry.id}
    >
      <div>
        <span className="font-medium text-foreground">{source}</span>{" "}
        {activityName(type, language)}
        {entry.kind === "run" && (
          <span>
            {" "}
            · {entry.events.length} {language === "zh" ? "条记录" : "records"}
          </span>
        )}
        <span className="px-1">·</span>
        {time(first.at)}
      </div>
      {entry.kind === "event" ? (
        <ActivityRecord event={entry.event} language={language} />
      ) : entry.kind === "request" ? (
        <div>
          <ApprovalCard request={entry.request} />
          {entry.events
            .filter((e) => e.type !== "request.created")
            .map((e) => (
              <ActivityRecord key={e.id} event={e} language={language} nested />
            ))}
        </div>
      ) : (
        <div>
          {entry.kind === "run" && (
            <div className="mt-1 whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
              {entry.run.snapshot.projectName} · {entry.run.snapshot.branch} ·{" "}
              {entry.run.snapshot.path}
              {"\n"}
              {entry.run.snapshot.description}
              {"\n"}
              {data.tasks.find((t) => t.id === entry.run.taskId)?.text}
              {entry.run.reason && "\n" + entry.run.reason}
            </div>
          )}
          {entry.kind === "run" && <RunStream runId={entry.run.id} />}
          {entry.events
            .filter(
              (e) =>
                e.type !== "artifact.published" ||
                !data.artifacts.some(
                  (a) =>
                    a.id === (e.data as { artifactId?: string })?.artifactId &&
                    (a.id === entry.run.resultArtifactId ||
                      a.provenance === "Native tool observation"),
                ),
            )
            .map((e) => (
              <ActivityRecord key={e.id} event={e} language={language} nested />
            ))}
          {entry.kind === "run" &&
            entry.run.result &&
            !streamItems[entry.run.id]?.length && (
              <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[13px]">
                {entry.run.result}
              </pre>
            )}
        </div>
      )}
    </Event>
  );
}

function Comment({
  avatar,
  tone,
  name,
  time,
  children,
}: {
  avatar: ReactNode;
  tone?: "dark" | "green" | "blue" | "violet";
  name: string;
  time: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-xs">
      <div className="flex items-center gap-2 px-4 pt-3.5">
        <Avatar tone={tone}>{avatar}</Avatar>
        <span className="text-xs font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">{time}</span>
        <Button size="icon" className="ml-auto size-6">
          <MoreHorizontal size={14} />
        </Button>
      </div>
      <div className="px-4 pb-4 pt-2 text-[13px] leading-5">{children}</div>
      <div className="flex h-10 items-center gap-2 border-t border-border px-4 text-xs text-muted-foreground">
        <Avatar tone={tone}>{avatar}</Avatar>
        <span className="flex-1">Leave a reply…</span>
        <Paperclip size={13} />
        <ArrowUp size={13} />
      </div>
    </div>
  );
}

function ApprovalCard({ request }: { request: RelayRequest }) {
  const { data, action, busy } = useBackend();
  const [answer, setAnswer] = useDraft("request-" + request.id);
  const upload = useUpload(request.issueId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = textareaRef.current;
    if (t) {
      t.style.height = "auto";
      t.style.height = `${t.scrollHeight}px`;
    }
  }, [answer]);
  const submit = async () => {
    if (request.kind === "input") {
      await decide("answer");
      return;
    }
    const result = await action("comment.create", {
      issueId: request.issueId,
      text: `Reply to ${request.title}: ${answer}`,
    });
    if (result) setAnswer("");
  };
  const decide = async (decision: string) => {
    const result = await action("request.decide", {
      requestId: request.id,
      revision: request.revision,
      decision,
      answer,
    });
    if (result) setAnswer("");
  };
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-xs">
      <div className="px-4 pb-4 pt-4">
        <div className="flex items-center gap-2 text-xs">
          <Avatar tone="violet">{request.source[0]}</Avatar>
          <span className="font-medium">{request.source}</span>
          <span className="text-muted-foreground">{request.status}</span>
        </div>
        <div className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-5">
          {request.title}
          {"\n"}
          {request.body}
        </div>
        {request.options?.map((o) => (
          <div key={o.value} className="mt-2 text-xs text-muted-foreground">
            {o.label} · {o.value}
          </div>
        ))}
        <div className="mt-2 text-xs text-muted-foreground">
          Blocking scope:{" "}
          {request.scope === "issue"
            ? "Whole issue"
            : [
                ...request.scope.taskIds.map(
                  (id) => data.tasks.find((t) => t.id === id)?.text || id,
                ),
                ...request.scope.bindingIds.map(
                  (id) =>
                    data.bindings.find((b) => b.id === id)?.description || id,
                ),
                ...request.scope.worktreeIds.map(
                  (id) => data.worktrees.find((w) => w.id === id)?.name || id,
                ),
              ].join(", ")}
          {request.action && " · " + actionDescription(request)}
        </div>
        {request.artifactIds
          .map((id) => data.artifacts.find((a) => a.id === id))
          .filter((a) => a !== undefined)
          .map((a) => (
            <div key={a.id} className="mt-2 text-xs">
              <div>
                {a.title} · {a.version.slice(0, 12)}
              </div>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                {a.content}
              </pre>
            </div>
          ))}
      </div>
      <div className="border-t border-border px-4 py-3">
        {request.status !== "Pending" ? (
          <div className="flex items-start gap-2">
            <Avatar tone="green">H</Avatar>
            <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-5">
              {request.status}
              {request.answer && " · " + request.answer}
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <Avatar tone="green">H</Avatar>
              <textarea
                ref={textareaRef}
                rows={1}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                aria-label="Approval reply"
                placeholder="Leave a reply…"
                className="min-h-5 min-w-0 flex-1 resize-none overflow-hidden bg-transparent p-0 text-[13px]! leading-5 outline-none placeholder:text-muted-foreground/70"
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    if (answer.trim()) void submit();
                  }
                }}
              />
              <input {...upload.inputProps} />
              <button
                type="button"
                aria-label="Attach files"
                onClick={upload.choose}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <Paperclip size={15} />
              </button>
              <button
                type="button"
                aria-label="Submit answer"
                disabled={!answer.trim() || busy}
                onClick={() => void submit()}
                className="ml-2 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              >
                <ArrowUp size={16} />
              </button>
            </div>
            {request.kind !== "input" && (
              <div className="mt-3 flex gap-2 pl-7">
                <Button
                  variant="default"
                  disabled={busy}
                  onClick={() => void decide("approve")}
                >
                  <Check size={13} />
                  Approve
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !answer.trim()}
                  onClick={() => void decide("changes")}
                >
                  Request changes
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SidebarItem({
  icon,
  label,
  active,
  count,
  onClick,
  inset = false,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  count?: number;
  onClick?: () => void;
  inset?: boolean;
}) {
  return (
    <Button
      onClick={onClick}
      className={`h-7 w-full justify-start text-[13px]! font-normal ${
        inset ? "pl-5 pr-2" : "px-2"
      } ${active ? "bg-zinc-200/70 text-foreground" : ""}`}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {count ? (
        <span className="text-[11px] text-muted-foreground">{count}</span>
      ) : null}
    </Button>
  );
}

type IssueStatus = "Human input" | "In progress" | "Todo" | "Done";
type IssuePriority = 0 | 1 | 2 | 3 | 4;

type Issue = {
  uid: string;
  id: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority?: IssuePriority;
  project: string;
  agent?: string;
  updated: string;
};

function StatusIcon({ status }: { status: IssueStatus }) {
  if (status === "Done") {
    return (
      <span className="flex size-4 items-center justify-center rounded-full bg-indigo-500 text-white">
        <Check size={10} />
      </span>
    );
  }
  if (status === "In progress") {
    return <CircleDot size={16} className="text-amber-500" />;
  }
  if (status === "Human input") {
    return <CircleDot size={16} className="text-violet-500" />;
  }
  return <Circle size={16} className="text-zinc-400" />;
}

const priorityOptions = [
  "No priority",
  "Urgent",
  "High",
  "Medium",
  "Low",
] as const;

function PriorityIcon({ priority }: { priority: IssuePriority }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-muted-foreground"
    >
      {priority === 0 ? (
        <path
          d="M1 7.5h3m2 0h3m2 0h3"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      ) : priority === 1 ? (
        <>
          <rect x="1" y="1" width="13" height="13" rx="2" fill="currentColor" />
          <path
            d="M7.5 4v4"
            stroke="var(--color-card)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="7.5" cy="10.5" r="0.8" fill="var(--color-card)" />
        </>
      ) : (
        <>
          <rect x="1" y="9" width="3" height="5" rx="0.7" fill="currentColor" />
          <rect
            x="6"
            y="5"
            width="3"
            height="9"
            rx="0.7"
            fill="currentColor"
            opacity={priority <= 3 ? 1 : 0.4}
          />
          <rect
            x="11"
            y="1"
            width="3"
            height="13"
            rx="0.7"
            fill="currentColor"
            opacity={priority === 2 ? 1 : 0.4}
          />
        </>
      )}
    </svg>
  );
}

function PriorityPicker({
  priority,
  onChange,
}: {
  priority: IssuePriority;
  onChange: (priority: IssuePriority) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const selectPriority = (value: IssuePriority) => {
    onChange(value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    optionRefs.current[priority]?.focus();
    const handleOutsideClick = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handleOutsideClick);
    return () =>
      document.removeEventListener("pointerdown", handleOutsideClick);
  }, [open, priority]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "p" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing
      )
        return;
      if (
        (event.target as HTMLElement).closest(
          "input, textarea, select, [contenteditable='true']",
        )
      )
        return;
      event.preventDefault();
      setOpen((current) => !current);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!open) {
            setOpen(true);
          } else {
            const index = optionRefs.current.findIndex(
              (option) => option === document.activeElement,
            );
            const next =
              (index +
                (event.key === "ArrowDown" ? 1 : -1) +
                priorityOptions.length) %
              priorityOptions.length;
            optionRefs.current[next]?.focus();
          }
        } else if (open && /^[0-4]$/.test(event.key)) {
          event.preventDefault();
          selectPriority(Number(event.key) as IssuePriority);
        } else if (open && (event.key === "Home" || event.key === "End")) {
          event.preventDefault();
          optionRefs.current[event.key === "Home" ? 0 : 4]?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={`inline-flex min-h-8 items-center gap-2 rounded-full px-1.5 text-[13px]! font-normal outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${open ? "bg-muted" : ""} ${priority === 0 ? "text-muted-foreground" : "text-foreground"}`}
        onClick={() => setOpen((current) => !current)}
      >
        <PriorityIcon priority={priority} />
        <span>
          {priority === 0 ? "Set priority" : priorityOptions[priority]}
        </span>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Set priority"
          className="absolute left-0 top-full z-30 mt-1 w-64 max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-xl border border-border bg-card shadow-lg"
        >
          <div className="flex h-9 items-center justify-between border-b border-border px-3 text-[13px] text-muted-foreground">
            <span>Set priority to…</span>
            <kbd className="rounded border border-border px-1.5 py-0.5 text-[11px] font-sans leading-none">
              P
            </kbd>
          </div>
          <div className="p-1.5">
            {priorityOptions.map((label, index) => (
              <button
                key={label}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={priority === index}
                className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px]! font-normal text-foreground outline-none hover:bg-muted focus:bg-muted ${priority === index ? "bg-muted" : ""}`}
                onClick={() => selectPriority(index as IssuePriority)}
              >
                <PriorityIcon priority={index as IssuePriority} />
                <span className="flex-1 text-left">{label}</span>
                {priority === index && <Check size={15} />}
                <span className="ml-1 w-3 text-right text-[11px] text-muted-foreground">
                  {index}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function IssuesList({
  issues,
  onOpen,
  onCreate,
  startCreating = false,
  onCreateDismiss,
}: {
  issues: Issue[];
  onOpen: (issue: Issue) => void;
  onCreate: (
    title: string,
    description: string,
    status: IssueStatus,
    project: string,
    agent: string,
    createMore: boolean,
    attachments?: File[],
  ) => Promise<boolean>;
  startCreating?: boolean;
  onCreateDismiss?: () => void;
}) {
  const [listView, setListView] = useState<"Active" | "Backlog" | "All issues">(
    "All issues",
  );
  const [createOpen, setCreateOpen] = useState(startCreating);
  const { busy, connection, state } = useBackend();
  const [title, setTitle] = useDraft("new-issue-title");
  const [newAttachments, setNewAttachments] = useState<File[]>([]);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const [description, setDescription] = useDraft("new-issue-description");
  const newStatus: IssueStatus = "Todo";
  const newProject = "";
  const newAgent = "";
  const [createMore, setCreateMore] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const filteredIssues = issues.filter((issue) => {
    if (listView === "Active") {
      return issue.status === "Human input" || issue.status === "In progress";
    }
    if (listView === "Backlog") return issue.status === "Todo";
    return true;
  });
  const groupedIssues = filteredIssues.reduce<Record<IssueStatus, Issue[]>>(
    (groups, issue) => {
      groups[issue.status].push(issue);
      return groups;
    },
    { "Human input": [], "In progress": [], Todo: [], Done: [] },
  );

  const createIssue = async () => {
    if (!title.trim()) return;
    const result = await onCreate(
      title.trim(),
      description.trim(),
      newStatus,
      newProject,
      newAgent,
      createMore,
      newAttachments,
    );
    if (!result) return;
    setTitle("");
    setDescription("");
    setNewAttachments([]);
    if (!createMore) {
      setCreateOpen(false);
      onCreateDismiss?.();
    }
  };

  return (
    <>
      <main className="px-3">
        <div className="flex h-8 items-center gap-1">
          {(["Active", "Backlog", "All issues"] as const).map((option) => (
            <Button
              key={option}
              variant={listView === option ? "outline" : "ghost"}
              onClick={() => setListView(option)}
              className={`h-6 rounded-full px-2.5 text-[11px]! font-normal ${
                listView === option ? "bg-zinc-100 shadow-none" : ""
              }`}
            >
              {option}
            </Button>
          ))}
          <Button size="icon" className="size-7">
            <Layers3 size={13} />
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="outline" size="icon" className="size-7">
              <ListFilter size={13} />
            </Button>
            <Button variant="outline" size="icon" className="size-7">
              <SlidersHorizontal size={13} />
            </Button>
            <Button variant="outline" size="icon" className="size-7">
              <Square size={13} />
            </Button>
          </div>
        </div>

        <div className="mt-1 space-y-1">
          {(Object.entries(groupedIssues) as [IssueStatus, Issue[]][])
            .filter(([, group]) => group.length)
            .map(([groupStatus, group]) => (
              <div key={groupStatus}>
                <div className="flex h-8 items-center rounded-md bg-zinc-100/80 px-2 text-xs">
                  <ChevronDown
                    size={13}
                    className="mr-2 text-muted-foreground"
                  />
                  <StatusIcon status={groupStatus} />
                  <span className="ml-2 font-medium">{groupStatus}</span>
                  <span className="ml-2 text-muted-foreground">
                    {group.length}
                  </span>
                  <Button
                    size="icon"
                    className="ml-auto size-7"
                    onClick={() => setCreateOpen(true)}
                  >
                    <Plus size={13} />
                  </Button>
                </div>
                <div>
                  {group.map((issue) => (
                    <Button
                      key={issue.id}
                      onClick={() => onOpen(issue)}
                      className="h-10 w-full justify-start rounded-md px-2 text-left font-normal hover:bg-zinc-100/70"
                    >
                      <Square size={13} className="shrink-0 text-zinc-400" />
                      <MoreHorizontal
                        size={13}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span className="w-14 shrink-0 text-[12px] text-muted-foreground">
                        {issue.id}
                      </span>
                      <StatusIcon status={issue.status} />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                        {issue.title}
                      </span>
                      {issue.agent && (
                        <Avatar
                          tone={issue.agent.includes("Pi") ? "blue" : "green"}
                        >
                          {issue.agent.slice(0, 1)}
                        </Avatar>
                      )}
                      <span className="ml-5 w-14 shrink-0 text-right text-[11px] text-muted-foreground">
                        {issue.updated}
                      </span>
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          {!filteredIssues.length && (
            <div className="py-16 text-center text-xs text-muted-foreground">
              {connection
                ? `Disconnected: ${connection}`
                : !state
                  ? "Loading…"
                  : "No issues in this view"}
            </div>
          )}
        </div>
      </main>

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-6">
          <div
            role="dialog"
            aria-modal="true"
            className={`flex w-full flex-col overflow-hidden border border-border bg-card shadow-xl transition-all ${
              expanded
                ? "h-[calc(100vh-2rem)] max-w-none rounded-xl"
                : "max-w-3xl rounded-2xl"
            }`}
          >
            <div className="flex h-12 items-center px-5">
              <Folder size={15} className="text-blue-500" />
              <span className="ml-2 text-[13px] text-muted-foreground">
                Relay
              </span>
              <ChevronRight size={13} className="mx-1 text-muted-foreground" />
              <span className="text-[13px] font-medium">New issue</span>
              <Button
                size="icon"
                className="ml-auto size-7"
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </Button>
              <Button
                size="icon"
                className="size-7"
                onClick={() => {
                  setCreateOpen(false);
                  onCreateDismiss?.();
                }}
              >
                <X size={15} />
              </Button>
            </div>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Issue title"
              className="w-full bg-transparent px-5 pt-3 text-xl font-semibold outline-none placeholder:text-muted-foreground"
            />
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Add description…"
              className={`w-full resize-none bg-transparent px-5 py-3 text-[15px] leading-6 outline-none transition-all placeholder:text-muted-foreground ${
                expanded ? "min-h-0 flex-1" : "min-h-20"
              }`}
            />
            <div className="flex h-14 shrink-0 items-center border-t border-border px-4">
              <input
                ref={attachmentRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) =>
                  setNewAttachments(Array.from(e.target.files || []))
                }
              />
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                aria-label="Attach issue files"
                title={newAttachments.map((f) => f.name).join(", ")}
                onClick={() => attachmentRef.current?.click()}
              >
                <Paperclip size={14} />
              </Button>
              <Button
                className="ml-auto gap-2 font-normal text-foreground hover:bg-transparent"
                onClick={() => setCreateMore((current) => !current)}
              >
                <span
                  className={`flex h-5 w-9 items-center rounded-full p-0.5 transition-colors ${
                    createMore ? "bg-violet-500" : "bg-zinc-300"
                  }`}
                >
                  <span
                    className={`size-4 rounded-full bg-white shadow-sm transition-transform ${
                      createMore ? "translate-x-4" : ""
                    }`}
                  />
                </span>
                Create more
              </Button>
              <Button
                variant="default"
                className="ml-3 rounded-full bg-violet-600 px-4 hover:bg-violet-700"
                disabled={!title.trim() || busy}
                onClick={createIssue}
              >
                Create issue
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

type Spec = {
  name: string;
  product: string;
  tech: string;
  id?: string;
  versionId?: string;
  versionNumber?: number;
};

type Worktree = {
  id: string;
  name: string;
  branch: string;
  path: string;
  spec: Spec;
};

type Project = {
  health?: string;
  activeIssues?: number;
  lastActivity?: string;
  id: string;
  name: string;
  path: string;
  worktrees: Worktree[];
};

type AgentBinding = {
  id: string;
  agent: "Codex" | "Pi";
  projectId: string;
  worktreeId: string;
  routingDescription: string;
  status: "Ready" | "Running" | "Waiting";
};

type InboxItem = {
  requestId: string;
  id: string;
  kind: "triage" | "review" | "agent";
  issueId: string;
  title: string;
  actor: string;
  summary: string;
  time: string;
  unread: boolean;
  archived: boolean;
};

function ProjectsList({
  projects,
  onOpen,
  onCreate,
}: {
  projects: Project[];
  onOpen: (project: Project) => void;
  onCreate: (name: string, path: string) => Promise<boolean>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const { busy } = useBackend();
  const [name, setName] = useDraft("project-name");
  const [path, setPath] = useDraft("project-path");

  const createProject = async () => {
    if (!name.trim() || !path.trim()) return;
    if (!(await onCreate(name.trim(), path.trim()))) return;
    setName("");
    setPath("");
    setCreateOpen(false);
  };

  return (
    <>
      <main>
        <div className="flex h-8 items-center border-b border-border px-3">
          <Button
            variant="outline"
            className="h-6 rounded-full bg-zinc-100 px-2.5 text-[11px]! font-normal"
          >
            All projects
          </Button>
          <Button size="icon" className="ml-1 size-7">
            <Layers3 size={13} />
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="outline" size="icon" className="size-7">
              <ListFilter size={13} />
            </Button>
            <Button variant="outline" size="icon" className="size-7">
              <SlidersHorizontal size={13} />
            </Button>
            <Button variant="outline" size="icon" className="size-7">
              <Square size={13} />
            </Button>
            <Button
              className="ml-2 font-normal text-foreground"
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={13} />
              New project
            </Button>
          </div>
        </div>

        <div className="min-w-[48rem] px-3 pt-1">
          <div className="grid h-8 grid-cols-[minmax(16rem,1fr)_8rem_7rem_7rem_8rem] items-center px-3 text-[11px] text-muted-foreground">
            <span>Name</span>
            <span>Health</span>
            <span>Worktrees</span>
            <span>Active issues</span>
            <span>Last activity</span>
          </div>
          {projects.map((project, index) => (
            <Button
              key={project.id}
              layout="grid"
              onClick={() => onOpen(project)}
              className="h-10 w-full grid-cols-[minmax(16rem,1fr)_8rem_7rem_7rem_8rem] items-center justify-normal gap-0 rounded-md px-3 text-left font-normal hover:bg-zinc-100/70"
            >
              <span className="flex min-w-0 items-center gap-3">
                <Box
                  size={14}
                  className={index % 2 ? "text-cyan-500" : "text-rose-500"}
                />
                <span className="truncate text-[13px] font-medium text-foreground">
                  {project.name}
                </span>
              </span>
              <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {project.health || "Unknown"}
              </span>
              <span className="text-xs">{project.worktrees.length}</span>
              <span className="text-xs">{project.activeIssues || 0}</span>
              <span className="text-[11px] text-muted-foreground">
                {project.lastActivity || "—"}
              </span>
            </Button>
          ))}
        </div>
      </main>

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 px-4 pt-24">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl"
          >
            <div className="flex items-center border-b border-border px-4 py-3">
              <Folder size={15} className="text-muted-foreground" />
              <span className="ml-2 text-sm font-medium">New project</span>
              <Button
                size="icon"
                className="ml-auto size-7"
                onClick={() => setCreateOpen(false)}
              >
                <MoreHorizontal size={15} />
              </Button>
            </div>
            <div className="space-y-4 p-5">
              <div>
                <div className="mb-1.5 text-xs font-medium">Project name</div>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. ab-gateway"
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-[13px] outline-none focus:border-ring"
                />
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium">
                  Local directory
                </div>
                <DirectoryField
                  value={path}
                  onChange={setPath}
                  placeholder="Choose a repository folder"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="default"
                disabled={!name.trim() || !path.trim() || busy}
                onClick={createProject}
              >
                Create project
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ProjectDetail({
  project,
  onAddWorktree,
  onUpdateSpec,
}: {
  project: Project;
  onAddWorktree: (projectId: string, worktree: Worktree) => Promise<any>;
  onUpdateSpec: (
    projectId: string,
    worktreeId: string,
    document: "product" | "tech",
    value: string,
  ) => void;
}) {
  const [selectedWorktreeId, setSelectedWorktreeId] = useState(
    project.worktrees[0]?.id ?? "",
  );
  const [document, setDocument] = useState<"product" | "tech">("product");
  const [createOpen, setCreateOpen] = useState(false);
  const { busy, data } = useBackend();
  const [name, setName] = useDraft("worktree-name-" + project.id);
  const [branch, setBranch] = useDraft("worktree-branch-" + project.id);
  const [path, setPath] = useDraft("worktree-path-" + project.id);
  const [specName, setSpecName] = useDraft("worktree-spec-" + project.id);
  const selectedWorktree =
    project.worktrees.find((worktree) => worktree.id === selectedWorktreeId) ??
    project.worktrees[0];

  const spec = useSpec(selectedWorktree?.id, document);
  const specOptions = data.specs
    .filter((s) => s.projectId === project.id)
    .flatMap((s) =>
      data.specVersions
        .filter((v) => v.specId === s.id)
        .map((v) => ({
          label: s.name + " · V" + v.number + " · " + s.id,
          specId: s.id,
          versionId: v.id,
        })),
    );

  const addWorktree = async () => {
    if (!name.trim() || !branch.trim() || !path.trim() || !specName.trim())
      return;
    const selectedSpec = specOptions.find((o) => o.label === specName);
    const id = `wt-${Date.now()}`;
    const result = await onAddWorktree(project.id, {
      id,
      name: name.trim(),
      branch: branch.trim(),
      path: path.trim(),
      spec: {
        name: specName.trim(),
        id: selectedSpec?.specId,
        versionId: selectedSpec?.versionId,
        product: "",
        tech: "",
      },
    });
    if (!result) return;
    setSelectedWorktreeId(result.id);
    setName("");
    setBranch("");
    setPath("");
    setSpecName("");
    setCreateOpen(false);
  };

  return (
    <>
      <main className="flex min-h-[calc(100vh-2.5rem)] flex-col">
        <div className="flex items-center border-b border-border px-6 py-5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
            <Folder size={17} />
          </span>
          <div className="ml-3">
            <div className="text-sm font-semibold">{project.name}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {project.path}
            </div>
          </div>
          <Button
            variant="default"
            className="ml-auto"
            onClick={() => setCreateOpen(true)}
          >
            <GitBranch size={14} />
            New worktree
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)]">
          <section className="border-r border-border p-3">
            <div className="mb-2 flex items-center px-2 text-[11px] font-medium text-muted-foreground">
              Worktrees
              <span className="ml-1.5">{project.worktrees.length}</span>
            </div>
            <div className="space-y-1">
              {project.worktrees.map((worktree) => (
                <Button
                  key={worktree.id}
                  onClick={() => setSelectedWorktreeId(worktree.id)}
                  className={`h-auto w-full justify-start px-2 py-2.5 text-left font-normal ${
                    selectedWorktree?.id === worktree.id
                      ? "bg-zinc-200/70 text-foreground"
                      : ""
                  }`}
                >
                  <GitBranch size={14} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">
                      {worktree.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                      {worktree.branch}
                    </span>
                  </span>
                </Button>
              ))}
              {!project.worktrees.length && (
                <div className="px-2 py-8 text-center text-xs text-muted-foreground">
                  No worktrees yet
                </div>
              )}
            </div>
          </section>

          {selectedWorktree ? (
            <section className="min-w-0">
              <div className="border-b border-border px-6 py-4">
                <div className="flex items-center gap-2">
                  <GitBranch size={15} className="text-muted-foreground" />
                  <span className="text-sm font-medium">
                    {selectedWorktree.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {selectedWorktree.branch}
                  </span>
                </div>
                <div className="mt-2 text-[11px] text-muted-foreground">
                  {selectedWorktree.path}
                </div>
                <div className="mt-4 flex items-center gap-2 text-xs">
                  <FileText size={14} className="text-violet-500" />
                  <span className="font-medium">
                    {selectedWorktree.spec.name}
                  </span>
                  <span className="text-muted-foreground">
                    Bound spec · V{selectedWorktree.spec.versionNumber} · Draft
                  </span>
                </div>
              </div>

              <div className="flex h-10 items-center border-b border-border px-4">
                <Button
                  onClick={() => setDocument("product")}
                  className={`h-10 rounded-none px-3 ${
                    document === "product"
                      ? "border-b-2 border-foreground text-foreground"
                      : ""
                  }`}
                >
                  <FileText size={13} />
                  PRODUCT.md
                </Button>
                <Button
                  onClick={() => setDocument("tech")}
                  className={`h-10 rounded-none px-3 ${
                    document === "tech"
                      ? "border-b-2 border-foreground text-foreground"
                      : ""
                  }`}
                >
                  <FileText size={13} />
                  TECH.md
                </Button>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {spec.status}
                </span>
              </div>
              <textarea
                value={spec.content}
                onChange={(event) => spec.setContent(event.target.value)}
                aria-label={document === "product" ? "PRODUCT.md" : "TECH.md"}
                title={spec.path}
                spellCheck={false}
                className="min-h-[32rem] w-full resize-none bg-transparent p-6 font-mono text-[12px] leading-6 outline-none"
              />
            </section>
          ) : (
            <div className="flex items-center justify-center text-xs text-muted-foreground">
              Create a worktree to bind a spec
            </div>
          )}
        </div>
      </main>

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 px-4 pt-20">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl"
          >
            <div className="flex items-center border-b border-border px-4 py-3">
              <GitBranch size={15} className="text-muted-foreground" />
              <span className="ml-2 text-sm font-medium">New worktree</span>
            </div>
            <div className="grid grid-cols-2 gap-4 p-5">
              <div className="col-span-2">
                <div className="mb-1.5 text-xs font-medium">Name</div>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Retry policy"
                  className="h-9 w-full rounded-md border border-border px-3 text-[13px] outline-none focus:border-ring"
                />
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium">Branch</div>
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="feature/retry-policy"
                  className="h-9 w-full rounded-md border border-border px-3 text-[13px] outline-none focus:border-ring"
                />
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium">Spec</div>
                <input
                  list={"spec-options-" + project.id}
                  value={specName}
                  onChange={(event) => setSpecName(event.target.value)}
                  placeholder="Agent retry policy"
                  className="h-9 w-full rounded-md border border-border px-3 text-[13px] outline-none focus:border-ring"
                />
                <datalist id={"spec-options-" + project.id}>
                  {specOptions.map((o) => (
                    <option key={o.versionId} value={o.label} />
                  ))}
                </datalist>
              </div>
              <div className="col-span-2">
                <div className="mb-1.5 text-xs font-medium">
                  Worktree directory
                </div>
                <DirectoryField
                  value={path}
                  onChange={setPath}
                  placeholder="Choose directory"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button
                variant="default"
                disabled={
                  !name.trim() ||
                  !branch.trim() ||
                  !path.trim() ||
                  !specName.trim() ||
                  busy
                }
                onClick={addWorktree}
              >
                Create worktree
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

type SelectOption = { value: string; label: string; description?: string };

function SearchableSelect({
  label,
  icon,
  value,
  options,
  placeholder,
  open,
  onOpenChange,
  onChange,
  disabled = false,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  options: SelectOption[];
  placeholder: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState({ above: false, height: 180 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = options.find((option) => option.value === value);
  const filtered = options.filter((option) =>
    `${option.label} ${option.description ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    searchRef.current?.focus();
    const positionMenu = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      const viewport = rootRef.current
        ?.closest("[data-select-viewport]")
        ?.getBoundingClientRect();
      if (!rect || !viewport) return;
      const below = viewport.bottom - rect.bottom - 8;
      const above = rect.top - viewport.top - 8;
      const useAbove = below < 220 && above > below;
      setPlacement({
        above: useAbove,
        height: Math.min(180, Math.max(48, (useAbove ? above : below) - 48)),
      });
    };
    positionMenu();
    const outsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", outsideClick);
    window.addEventListener("resize", positionMenu);
    document.addEventListener("scroll", positionMenu, true);
    return () => {
      document.removeEventListener("pointerdown", outsideClick);
      window.removeEventListener("resize", positionMenu);
      document.removeEventListener("scroll", positionMenu, true);
    };
  }, [open]);

  useEffect(() => {
    if (open)
      listRef.current?.children[activeIndex]?.scrollIntoView({
        block: "nearest",
      });
  }, [activeIndex, query, open]);

  const select = (option: SelectOption) => {
    onChange(option.value);
    onOpenChange(false);
    triggerRef.current?.focus();
  };

  return (
    <div>
      <label id={`${id}-label`} className="mb-2 block text-xs font-medium">
        {label}
      </label>
      <div
        ref={rootRef}
        className="relative"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            onOpenChange(false);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            onOpenChange(false);
            triggerRef.current?.focus();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) onOpenChange(true);
            else if (filtered.length)
              setActiveIndex(
                (current) =>
                  (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    filtered.length) %
                  filtered.length,
              );
          } else if (open && event.key === "Enter") {
            event.preventDefault();
            if (filtered[activeIndex]) select(filtered[activeIndex]);
          }
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          aria-labelledby={`${id}-label ${id}-value`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? `${id}-list` : undefined}
          disabled={disabled}
          onClick={() => onOpenChange(!open)}
          className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg border bg-background px-3 text-left text-[12px]! outline-none transition-colors hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 ${open ? "border-ring" : "border-border"}`}
        >
          <span className="shrink-0 text-muted-foreground">{icon}</span>
          <span
            id={`${id}-value`}
            className="min-w-0 flex-1 truncate"
            title={
              selected
                ? `${selected.label}${selected.description ? ` · ${selected.description}` : ""}`
                : undefined
            }
          >
            {selected ? (
              <>
                <span>{selected.label}</span>
                {selected.description && (
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    {selected.description}
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <ChevronDown
            size={14}
            className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {open && (
          <div
            className={`absolute inset-x-0 z-20 overflow-hidden rounded-lg border border-border bg-card shadow-lg ${placement.above ? "bottom-full mb-1" : "top-full mt-1"}`}
          >
            <div className="flex h-10 items-center gap-2 border-b border-border px-3">
              <Search size={14} className="shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                role="combobox"
                aria-label={`Search ${label.toLowerCase()}`}
                aria-expanded={true}
                aria-controls={`${id}-list`}
                aria-autocomplete="list"
                aria-activedescendant={
                  filtered[activeIndex]
                    ? `${id}-option-${activeIndex}`
                    : undefined
                }
                placeholder={`Search ${label.toLowerCase()}…`}
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
              />
              <span className="text-[10px] text-muted-foreground">
                {filtered.length}
              </span>
            </div>
            <div
              ref={listRef}
              id={`${id}-list`}
              role="listbox"
              aria-label={label}
              className="overflow-y-auto p-1"
              style={{ maxHeight: placement.height }}
            >
              {filtered.map((option, index) => (
                <div
                  key={option.value}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={value === option.value}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(option)}
                  onMouseMove={() => setActiveIndex(index)}
                  className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs ${activeIndex === index ? "bg-muted" : ""}`}
                >
                  <span className="shrink-0 text-muted-foreground">{icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.description && (
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {value === option.value && (
                    <Check size={13} className="shrink-0" />
                  )}
                </div>
              ))}
              {!filtered.length && (
                <div className="px-3 py-5 text-center text-xs text-muted-foreground">
                  No {label.toLowerCase()} found
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BindAgentDialog({
  projects,
  issue,
  onClose,
  onBind,
}: {
  projects: Project[];
  issue: Pick<Issue, "id" | "title">;
  onClose: () => void;
  onBind: (binding: AgentBinding) => void;
}) {
  const { data, busy } = useBackend();
  const [agent, setAgent] = useState<"Codex" | "Pi">("Codex");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const selectedProject =
    projects.find((project) => project.id === projectId) ?? projects[0];
  const [worktreeId, setWorktreeId] = useState(
    selectedProject?.worktrees[0]?.id ?? "",
  );
  const [routingDescription, setRoutingDescription] = useDraft(
    "binding-description-" + issue.id,
  );
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [openSelector, setOpenSelector] = useState<
    "agent" | "project" | "worktree" | null
  >(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const routingId = useId();
  const selectedWorktree = selectedProject?.worktrees.find(
    (worktree) => worktree.id === worktreeId,
  );
  const canBind = Boolean(
    selectedProject &&
      selectedWorktree &&
      routingDescription.trim() &&
      data.agents.some((a) => a.name === agent) &&
      !busy,
  );

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current
      ?.querySelector<HTMLButtonElement>("[aria-haspopup='listbox']")
      ?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const elements = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea, [tabindex='0']",
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  const chooseProject = (project: Project) => {
    setProjectId(project.id);
    setWorktreeId(project.worktrees[0]?.id ?? "");
  };

  const bind = () => {
    if (!canBind) return;
    onBind({
      id: `binding-${Date.now()}`,
      agent,
      projectId,
      worktreeId,
      routingDescription: routingDescription.trim(),
      status: "Ready",
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-[3px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border px-6 py-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/60">
            <Bot size={18} className="text-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold leading-5">
              Bind agent
            </h2>
            <p
              id={descriptionId}
              className="mt-1.5 truncate text-xs text-muted-foreground"
              title={`${issue.id} · ${issue.title}`}
            >
              <span className="font-medium">{issue.id}</span>
              <span className="px-1.5 text-muted-foreground/50">·</span>
              {issue.title}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close bind agent dialog"
            onClick={onClose}
            className="-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X size={16} />
          </button>
        </div>

        <div
          data-select-viewport
          className="min-h-0 space-y-4 overflow-y-auto px-6 py-5"
        >
          <SearchableSelect
            label="Agent"
            icon={<Bot size={15} />}
            value={agent}
            options={data.agents.map((a) => ({ value: a.name, label: a.name }))}
            placeholder="Select an agent"
            open={openSelector === "agent"}
            onOpenChange={(open) =>
              setOpenSelector(
                open
                  ? "agent"
                  : (current) => (current === "agent" ? null : current),
              )
            }
            onChange={(value) => setAgent(value as "Codex" | "Pi")}
          />
          <SearchableSelect
            label="Project"
            icon={<Folder size={15} />}
            value={projectId}
            options={projects.map((project) => ({
              value: project.id,
              label: project.name,
              description: project.path,
            }))}
            placeholder="Select a project"
            open={openSelector === "project"}
            onOpenChange={(open) =>
              setOpenSelector(
                open
                  ? "project"
                  : (current) => (current === "project" ? null : current),
              )
            }
            onChange={(value) => {
              const project = projects.find((item) => item.id === value);
              if (project) chooseProject(project);
            }}
          />
          <SearchableSelect
            key={projectId}
            label="Worktree"
            icon={<GitBranch size={15} />}
            value={worktreeId}
            options={(selectedProject?.worktrees ?? []).map((worktree) => ({
              value: worktree.id,
              label: worktree.name,
              description: worktree.branch,
            }))}
            placeholder={
              selectedProject
                ? "No worktrees in this project"
                : "Select a project first"
            }
            disabled={!selectedProject?.worktrees.length}
            open={openSelector === "worktree"}
            onOpenChange={(open) =>
              setOpenSelector(
                open
                  ? "worktree"
                  : (current) => (current === "worktree" ? null : current),
              )
            }
            onChange={setWorktreeId}
          />

          <div>
            <label
              htmlFor={routingId}
              className="mb-2 block text-xs font-medium"
            >
              Routing instructions
            </label>
            <textarea
              id={routingId}
              aria-describedby={`${routingId}-hint`}
              value={routingDescription}
              onChange={(event) => setRoutingDescription(event.target.value)}
              placeholder="Describe the tasks this agent should handle…"
              className="block min-h-24 w-full resize-y rounded-xl border border-border bg-background/40 p-3 text-[12px]! leading-5 outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ring focus:ring-2 focus:ring-ring/15"
            />
            <div
              id={`${routingId}-hint`}
              className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <GitBranch size={12} className="shrink-0" />
              Triage uses these instructions to route tasks to this agent.
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-muted/25 px-6 py-4">
          <span
            className="mr-auto hidden min-w-0 truncate text-[11px] text-muted-foreground sm:block"
            title={selectedWorktree?.branch}
          >
            {selectedWorktree
              ? `${agent} · ${selectedWorktree.name}`
              : "Select a worktree to continue"}
          </span>
          <Button
            className="h-8 rounded-lg px-3 text-[12px]!"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            className="h-8 rounded-lg px-3 text-[12px]!"
            disabled={!canBind}
            onClick={bind}
          >
            <Plus size={13} />
            Bind agent
          </Button>
        </div>
      </div>
    </div>
  );
}

function SearchPage({
  query,
  issues,
  onOpenIssue,
}: {
  query: string;
  issues: Issue[];
  onOpenIssue: (issue: Issue) => void;
}) {
  const results = query.trim()
    ? issues.filter(
        (issue) =>
          issue.title.toLowerCase().includes(query.trim().toLowerCase()) ||
          issue.id.toLowerCase().includes(query.trim().toLowerCase()) ||
          issue.project.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : [];

  return (
    <main className="min-h-[calc(100vh-2.5rem)]">
      <div className="flex h-10 items-center border-b border-border px-2">
        <Button
          variant="outline"
          className="h-7 rounded-full bg-zinc-100 px-3 font-normal"
        >
          Issues
        </Button>
        <span className="ml-3 text-[11px] text-muted-foreground">
          Search by title, identifier, or project
        </span>
        <Button variant="outline" size="icon" className="ml-auto size-7">
          <ListFilter size={13} />
        </Button>
        <Button variant="outline" size="icon" className="ml-1 size-7">
          <SlidersHorizontal size={13} />
        </Button>
      </div>

      {query.trim() ? (
        <div className="px-3 py-3">
          <div className="mb-2 px-2 text-[11px] font-medium text-muted-foreground">
            {results.length} {results.length === 1 ? "result" : "results"}
          </div>
          {results.map((issue) => (
            <Button
              key={issue.id}
              onClick={() => onOpenIssue(issue)}
              className="h-10 w-full justify-start px-2 text-left font-normal hover:bg-zinc-100/70"
            >
              <StatusIcon status={issue.status} />
              <span className="w-16 text-[11px] text-muted-foreground">
                {issue.id}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                {issue.title}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {issue.project}
              </span>
            </Button>
          ))}
          {!results.length && (
            <div className="py-24 text-center text-xs text-muted-foreground">
              No issues found
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-[32rem] flex-col items-center justify-center text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-zinc-100 text-muted-foreground">
            <Search size={22} />
          </span>
          <div className="mt-4 text-[13px] font-medium">Search issues</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Find issues by title, identifier, or project
          </div>
        </div>
      )}
    </main>
  );
}

function InboxPage({
  items,
  onRead,
  onArchive,
  onOpenIssue,
}: {
  items: InboxItem[];
  onRead: (id: string) => void;
  onArchive: (id: string) => void;
  onOpenIssue: (issueId: string) => void;
}) {
  const [tab, setTab] = useState<"Inbox" | "Archived">("Inbox");
  const [filter, setFilter] = useState<"All" | InboxItem["kind"]>("All");
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? "");
  const { data, action, busy } = useBackend();

  const [submitted, setSubmitted] = useState(false);

  const visibleItems = items.filter(
    (item) =>
      item.archived === (tab === "Archived") &&
      (filter === "All" || item.kind === filter),
  );
  const selected =
    visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];
  const [response, setResponse] = useDraft(
    "request-" + (selected?.requestId || "none"),
  );
  useEffect(() => {
    if (selected?.unread) onRead(selected.id);
  }, [selected?.id, selected?.unread]);
  const filterOrder: Array<"All" | InboxItem["kind"]> = [
    "All",
    "triage",
    "review",
    "agent",
  ];

  const cycleFilter = () => {
    const currentIndex = filterOrder.indexOf(filter);
    setFilter(filterOrder[(currentIndex + 1) % filterOrder.length]);
  };

  const selectItem = (item: InboxItem) => {
    setSelectedId(item.id);
    setSubmitted(false);
    if (item.unread) onRead(item.id);
  };

  const request = data.requests.find((q) => q.id === selected?.requestId);
  const upload = useUpload(request?.issueId);
  const resolveItem = async (
    decision = selected?.kind === "review" ? "approve" : "answer",
  ) => {
    if (!request) return;
    const answer =
      decision === "changes"
        ? window.prompt("Changes requested", response)
        : response;
    if (answer === null) return;
    if (
      await action("request.decide", {
        requestId: request.id,
        revision: request.revision,
        decision,
        answer,
      })
    ) {
      setResponse("");
      setSubmitted(false);
    }
  };

  return (
    <main className="flex min-h-[calc(100vh-2.5rem)] flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-[24rem_minmax(0,1fr)]">
        <section className="border-r border-border">
          <div className="flex h-10 items-center border-b border-border px-3">
            <span className="text-[13px] font-medium">
              {tab === "Inbox" ? "Inbox" : "Archived"}
            </span>
            <Button size="icon" className="ml-1 size-7">
              <MoreHorizontal size={14} />
            </Button>
            <Button
              size="icon"
              className={`ml-auto size-7 ${
                tab === "Archived" ? "bg-zinc-200/70 text-foreground" : ""
              }`}
              onClick={() =>
                setTab((current) =>
                  current === "Inbox" ? "Archived" : "Inbox",
                )
              }
            >
              <Archive size={14} />
            </Button>
            <Button
              size="icon"
              className={`size-7 ${filter !== "All" ? "bg-zinc-200/70 text-foreground" : ""}`}
              onClick={cycleFilter}
            >
              <ListFilter size={13} />
            </Button>
            <Button size="icon" className="size-7">
              <SlidersHorizontal size={13} />
            </Button>
          </div>

          <div className="p-2">
            {visibleItems.map((item) => (
              <Button
                key={item.id}
                onClick={() => selectItem(item)}
                className={`h-auto w-full justify-start rounded-md border-l-2 border-transparent px-3 py-2.5 text-left font-normal ${
                  selected?.id === item.id
                    ? "border-l-blue-500 bg-muted/70 text-foreground"
                    : ""
                }`}
              >
                <span
                  className={`mt-1 size-1.5 shrink-0 rounded-full ${
                    item.unread ? "bg-blue-500" : "bg-transparent"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[12px] font-medium text-foreground">
                      {item.actor}
                    </span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {item.time}
                    </span>
                  </span>
                  <span className="mt-1 block truncate text-[12px] text-foreground">
                    {item.title}
                  </span>
                </span>
              </Button>
            ))}
            {!visibleItems.length && (
              <div className="flex min-h-72 flex-col items-center justify-center px-4 text-center">
                <Inbox size={20} className="text-muted-foreground" />
                <div className="mt-3 text-xs font-medium">
                  {tab === "Inbox"
                    ? "No notifications"
                    : "No archived notifications"}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {tab === "Inbox"
                    ? "Requests from Triage and agents appear here."
                    : "Archived requests will appear here."}
                </div>
              </div>
            )}
          </div>
        </section>

        {selected ? (
          <section className="overflow-y-auto">
            <div className="mx-auto max-w-2xl px-8 py-10">
              <div className="flex items-center">
                <span
                  className={`flex size-8 items-center justify-center rounded-full ${
                    selected.kind === "triage"
                      ? "bg-violet-100 text-violet-700"
                      : selected.kind === "review"
                        ? "bg-blue-100 text-blue-700"
                        : "bg-emerald-100 text-emerald-700"
                  }`}
                >
                  {selected.kind === "triage" ? (
                    <Sparkles size={15} />
                  ) : (
                    <Bot size={15} />
                  )}
                </span>
                <div className="ml-3">
                  <div className="text-sm font-medium">{selected.actor}</div>
                  <div className="text-[11px] text-muted-foreground">
                    requested your input · {selected.time}
                  </div>
                </div>
                <Button
                  variant="outline"
                  className="ml-auto"
                  onClick={() => onArchive(selected.id)}
                >
                  <Archive size={13} />
                  Archive
                </Button>
              </div>

              <div className="mt-8 text-xl font-semibold tracking-tight">
                {selected.title}
              </div>
              <Button
                className="mt-2 px-0 font-normal text-blue-600 hover:bg-transparent"
                onClick={() => onOpenIssue(selected.issueId)}
              >
                {selected.issueId}
                <ChevronRight size={12} />
              </Button>
              <div className="mt-6 text-[13px] leading-6">
                {selected.summary}
                {request?.options?.map((o) => (
                  <div key={o.value}>
                    {o.label} · {o.value}
                  </div>
                ))}
                {request?.artifactIds
                  .map((id) => data.artifacts.find((a) => a.id === id))
                  .filter((a) => a !== undefined)
                  .map((a) => (
                    <pre
                      key={a.id}
                      className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs"
                    >
                      {a.title} · {a.version.slice(0, 12)}
                      {"\n"}
                      {a.content}
                    </pre>
                  ))}
                {request?.status !== "Pending" && (
                  <div>
                    {request?.status} · {request?.answer}
                  </div>
                )}
              </div>

              {selected.kind === "review" ? (
                <div className="mt-8 border-t border-border pt-5">
                  <div className="text-xs font-medium">Review decision</div>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="default"
                      disabled={busy || request?.status !== "Pending"}
                      onClick={() => void resolveItem()}
                    >
                      <Check size={13} />
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || request?.status !== "Pending"}
                      onClick={() => void resolveItem("changes")}
                    >
                      Request changes
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-8 border-t border-border pt-5">
                  <div className="text-xs font-medium">Your response</div>
                  <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
                    <textarea
                      value={response}
                      onChange={(event) => setResponse(event.target.value)}
                      placeholder="Provide the details needed to continue…"
                      className="min-h-28 w-full resize-none bg-transparent p-3 text-[13px] leading-5 outline-none placeholder:text-muted-foreground"
                    />
                    <div className="flex items-center border-t border-border p-2">
                      <input {...upload.inputProps} />
                      <Button
                        size="icon"
                        className="size-7"
                        aria-label="Attach reply files"
                        onClick={upload.choose}
                      >
                        <Paperclip size={13} />
                      </Button>
                      <Button
                        variant="default"
                        className="ml-auto"
                        disabled={
                          !response.trim() ||
                          submitted ||
                          busy ||
                          request?.status !== "Pending"
                        }
                        onClick={() => void resolveItem()}
                      >
                        {submitted ? "Sending…" : "Send response"}
                        <ArrowUp size={13} />
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        ) : (
          <div className="flex items-center justify-center text-xs text-muted-foreground">
            Select an inbox item
          </div>
        )}
      </div>
    </main>
  );
}

function AgentPage() {
  const { data } = useBackend();
  const agents = data.agents.map((a) => ({
    ...a,
    status: a.status === "available" ? "Operational" : a.status,
    runs: data.runs.filter(
      (r) =>
        r.snapshot.command === a.command &&
        ["starting", "running", "stopping", "unknown"].includes(r.status),
    ).length,
    heartbeat: relative(a.heartbeat),
    tone: a.id === "codex" ? "green" : "blue",
  }));

  return (
    <main>
      <div className="px-3 py-3">
        <div className="mb-2 flex h-8 items-center px-3 text-[11px] text-muted-foreground">
          <span className="mr-2 size-1.5 rounded-full bg-emerald-500" />
          {agents.filter((a) => a.status === "Operational").length} services
          operational
        </div>
        <div className="grid h-8 grid-cols-[minmax(14rem,1fr)_9rem_7rem_7rem_7rem] items-center px-3 text-[11px] text-muted-foreground">
          <span>Service</span>
          <span>Status</span>
          <span>Version</span>
          <span>Active runs</span>
          <span>Heartbeat</span>
        </div>
        {agents.map((agent) => (
          <div
            key={agent.name}
            className="grid h-14 grid-cols-[minmax(14rem,1fr)_9rem_7rem_7rem_7rem] items-center rounded-md px-3 hover:bg-zinc-100/70"
          >
            <div className="flex items-center gap-3">
              <span
                className={`flex size-8 items-center justify-center rounded-md ${
                  agent.tone === "green"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-blue-100 text-blue-700"
                }`}
              >
                <Bot size={15} />
              </span>
              <div>
                <div className="text-[13px] font-medium">{agent.name}</div>
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {agent.command}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-emerald-700">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {agent.status}
            </div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {agent.version}
            </div>
            <div className="text-xs">{agent.runs}</div>
            <div className="text-[11px] text-muted-foreground">
              {agent.heartbeat}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

function SettingsPage() {
  const { data, action } = useBackend();
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(data.settings.configured);
  const [testing, setTesting] = useState(false);
  const [connected, setConnected] = useState(
    data.settings.connection === "connected",
  );

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    if (await action("settings.save", { apiKey })) {
      setSaved(true);
      setConnected(false);
      setApiKey("");
    }
  };
  const testConnection = async () => {
    if (!saved) return;
    setTesting(true);
    const result = await action("settings.test");
    setTesting(false);
    setConnected(result?.connection === "connected");
    if (result && result.connection !== "connected")
      window.alert(result.connection);
  };

  return (
    <main>
      <div className="mx-auto max-w-3xl px-8 py-10">
        <section className="min-w-0">
          <div className="text-lg font-semibold tracking-tight">Jev API</div>
          <div className="mt-1 text-[13px] leading-5 text-muted-foreground">
            Configure the API key Relay uses to create and coordinate Jev agent
            runs.
          </div>

          <div className="mt-8 border-t border-border">
            <div className="grid grid-cols-[10rem_minmax(0,1fr)] gap-8 py-6">
              <div>
                <div className="text-[13px] font-medium">API key</div>
                <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  Required for Jev requests.
                </div>
              </div>
              <div>
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setSaved(false);
                      setConnected(false);
                    }}
                    placeholder="jev_••••••••••••••••"
                    autoComplete="off"
                    spellCheck={false}
                    className="h-9 w-full rounded-md border border-border bg-background px-3 pr-10 font-mono text-[12px] outline-none focus:border-ring"
                  />
                  <Button
                    size="icon"
                    className="absolute right-1 top-1 size-7"
                    onClick={() => setShowKey((current) => !current)}
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </Button>
                </div>
                <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <ShieldCheck size={13} />
                  The key is hidden from issue activity and agent output.
                </div>
                {saved && (
                  <div className="mt-3 flex items-center gap-3">
                    <span className="flex items-center gap-2 text-xs text-emerald-600">
                      <Check size={13} />
                      API key saved
                    </span>
                    <Button
                      variant="outline"
                      disabled={testing}
                      onClick={testConnection}
                    >
                      {testing ? "Testing…" : "Test connection"}
                    </Button>
                    {connected && (
                      <span className="flex items-center gap-1.5 text-xs text-emerald-600">
                        <span className="size-1.5 rounded-full bg-emerald-500" />
                        Connected
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-end border-t border-border pt-4">
            <Button
              variant="default"
              disabled={!apiKey.trim() || saved}
              onClick={saveKey}
            >
              Save changes
            </Button>
          </div>
        </section>
      </div>
    </main>
  );
}

function RelayView() {
  const { data, action, busy, setStreamIssue } = useBackend();
  const [selectedIssueId, setSelectedIssueId] = useState(() =>
    decodeURIComponent(location.hash.replace("#issue/", "")),
  );
  const [controlsOpen, setControlsOpen] = useState(false);
  const [comment, setComment] = useDraft("comment-" + selectedIssueId);
  const issues: Issue[] = data.issues
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((i) => ({
      ...i,
      id: i.number,
      uid: i.id,
      priority: (i.priority || 0) as IssuePriority,
      project: [
        ...new Set(
          data.bindings
            .filter((b) => b.issueId === i.id && !b.removed)
            .map((b) => data.projects.find((p) => p.id === b.projectId)?.name),
        ),
      ].join(" + "),
      agent: [
        ...new Set(
          data.bindings
            .filter((b) => b.issueId === i.id && !b.removed)
            .map((b) => data.agents.find((a) => a.id === b.agentId)?.name),
        ),
      ].join(", "),
      updated: relative(i.updatedAt),
    }));
  const selectedIssue = issues.find((i) => i.uid === selectedIssueId) ||
    issues[0] || {
      id: "",
      uid: "",
      title: "",
      description: "",
      status: "Todo" as const,
      project: "",
      updated: "",
      priority: 0,
    };
  const rawIssue = data.issues.find((i) => i.id === selectedIssue.uid);
  useEffect(() => {
    setStreamIssue(selectedIssue.uid);
    return () => setStreamIssue("");
  }, [selectedIssue.uid, setStreamIssue]);
  const upload = useUpload(selectedIssue.uid);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const projects: Project[] = data.projects.map((p) => ({
    ...p,
    activeIssues: new Set(
      data.bindings
        .filter(
          (b) =>
            b.projectId === p.id &&
            !b.removed &&
            data.issues.some(
              (i) =>
                i.id === b.issueId &&
                (i.status === "In progress" || i.status === "Human input"),
            ),
        )
        .map((b) => b.issueId),
    ).size,
    lastActivity: relative(
      data.issues
        .filter((i) =>
          data.bindings.some((b) => b.projectId === p.id && b.issueId === i.id),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.updatedAt ||
        "",
    ),
    worktrees: data.worktrees
      .filter((w) => w.projectId === p.id)
      .map((w) => ({
        ...w,
        spec: {
          id: w.specId,
          versionId: w.specVersionId,
          name: data.specs.find((s) => s.id === w.specId)?.name || "",
          versionNumber: data.specVersions.find((v) => v.id === w.specVersionId)
            ?.number,
          product: "",
          tech: "",
        },
      })),
  }));
  const agentBindings: Record<string, AgentBinding[]> = {};
  for (const b of data.bindings.filter((b) => !b.removed)) {
    const number = data.issues.find((i) => i.id === b.issueId)?.number || "";
    const latest = data.runs.filter((r) => r.bindingId === b.id).at(-1);
    const binding: AgentBinding = {
      id: b.id,
      agent: b.agentId === "pi" ? "Pi" : "Codex",
      projectId: b.projectId,
      worktreeId: b.worktreeId,
      routingDescription: b.description,
      status:
        latest && ["starting", "running", "stopping"].includes(latest.status)
          ? "Running"
          : (latest && ["unknown"].includes(latest.status)) ||
              data.tasks.some(
                (t) => t.bindingId === b.id && t.status === "waiting",
              )
            ? "Waiting"
            : "Ready",
    };
    (agentBindings[number] ??= []).push(binding);
  }
  const inboxItems: InboxItem[] = data.notifications.map((n) => {
    const q = data.requests.find((q) => q.id === n.requestId)!;
    return {
      id: n.id,
      requestId: q.id,
      kind: n.category.toLowerCase() as InboxItem["kind"],
      issueId: data.issues.find((i) => i.id === n.issueId)?.number || "",
      title: q.title,
      actor: q.source,
      summary: q.body,
      time: time(n.createdAt),
      unread: !n.read,
      archived: n.archived,
    };
  });
  const availableLabels = data.labelCatalog;
  const issueLabels = rawIssue?.labels || [];
  const updateIssue = (change: Record<string, unknown>) =>
    action("issue.update", {
      issueId: selectedIssue.uid,
      revision: rawIssue?.revision,
      ...change,
    });
  const setIssueLabels = (fn: (labels: string[]) => string[]) =>
    void updateIssue({ labels: fn(issueLabels) });
  const [view, setView] = useState<
    | "search"
    | "inbox"
    | "issues"
    | "detail"
    | "projects"
    | "projectDetail"
    | "agent"
    | "settings"
  >(location.hash.startsWith("#issue/") ? "detail" : "issues");
  const [bindAgentOpen, setBindAgentOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const labelPickerRef = useRef<HTMLDivElement>(null);
  const labelTriggerRef = useRef<HTMLButtonElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [createIssueRequest, setCreateIssueRequest] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = window.localStorage.getItem("relay-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  const [language, setLanguage] = useState<"en" | "zh">(() =>
    window.localStorage.getItem("relay-language") === "zh" ? "zh" : "en",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("relay-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    window.localStorage.setItem("relay-language", language);
  }, [language]);

  useEffect(() => {
    if (!labelPickerOpen) {
      setLabelDraft("");
      return;
    }
    const handleOutsideClick = (event: PointerEvent) => {
      if (!labelPickerRef.current?.contains(event.target as Node))
        setLabelPickerOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      setLabelPickerOpen(false);
      labelTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [labelPickerOpen]);

  useEffect(() => {
    setLabelPickerOpen(false);
  }, [view, selectedIssue.id]);

  const ui =
    language === "zh"
      ? {
          inbox: "收件箱",
          issues: "任务",
          agent: "智能体",
          workspace: "工作区",
          projects: "项目",
          settings: "设置",
          search: "搜索任务",
          createIssue: "创建任务",
          lightMode: "切换到亮色模式",
          darkMode: "切换到暗色模式",
          switchLanguage: "切换到英文",
        }
      : {
          inbox: "Inbox",
          issues: "Issues",
          agent: "Agent",
          workspace: "Workspace",
          projects: "Projects",
          settings: "Settings",
          search: "Search issues",
          createIssue: "Create issue",
          lightMode: "Switch to light mode",
          darkMode: "Switch to dark mode",
          switchLanguage: "Switch to Chinese",
        };

  const sendComment = async () => {
    if (!comment.trim()) return;
    const r = await action("comment.create", {
      issueId: selectedIssue.uid,
      text: comment,
    });
    if (r) setComment("");
  };

  const openIssue = (issue: Issue) => {
    setSelectedIssueId(issue.uid);
    location.hash = "issue/" + issue.uid;
    setView("detail");
  };

  const createIssue = async (
    title: string,
    description: string,
    _status: IssueStatus,
    _project: string,
    _agent: string,
    createMore: boolean,
    attachments?: File[],
  ) => {
    const result = await action("issue.create", {
      title,
      description,
      attachments: await filesPayload(attachments || []),
    });
    if (!result) return false;
    if (!createMore) {
      setSelectedIssueId(result.id);
      location.hash = "issue/" + result.id;
      setView("detail");
    }
    return true;
  };
  const openProject = (project: Project) => {
    setSelectedProjectId(project.id);
    setView("projectDetail");
  };

  const createProject = async (name: string, path: string) => {
    const result = await action("project.create", { name, path });
    if (!result) return false;
    setSelectedProjectId(result.id);
    setView("projectDetail");
    return true;
  };
  const addWorktree = async (projectId: string, worktree: Worktree) => {
    return await action("worktree.create", {
      projectId,
      name: worktree.name,
      path: worktree.path,
      branch: worktree.branch,
      ...(worktree.spec.id
        ? { specId: worktree.spec.id, specVersionId: worktree.spec.versionId }
        : { newSpec: { name: worktree.spec.name } }),
    });
  };
  const updateSpec = () => {};
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const selectedIssueBindings = agentBindings[selectedIssue.id] ?? [];
  const isProjectView = view === "projects" || view === "projectDetail";
  const isSettingsView = view === "settings";
  const isInboxView = view === "inbox";
  const isAgentView = view === "agent";

  const openIssueById = (issueId: string) => {
    const issue = issues.find((item) => item.id === issueId);
    if (issue) openIssue(issue);
  };

  const readInboxItem = (id: string) =>
    void action("notification.update", { notificationId: id, read: true });
  const archiveInboxItem = (id: string) =>
    void action("notification.update", {
      notificationId: id,
      archived: true,
      read: true,
    });
  const bindAgentToIssue = async (binding: AgentBinding) => {
    const result = await action("binding.save", {
      issueId: selectedIssue.uid,
      projectId: binding.projectId,
      worktreeId: binding.worktreeId,
      agentId: binding.agent.toLowerCase(),
      description: binding.routingDescription,
    });
    if (result) {
      sessionStorage.removeItem("binding-description-" + selectedIssue.id);
      setBindAgentOpen(false);
    }
  };
  const addIssueLabel = () => {
    const label = labelDraft.trim();
    if (!label) return;
    setIssueLabels((current) =>
      current.some((item) => item.toLowerCase() === label.toLowerCase())
        ? current
        : [...current, label],
    );
    setLabelDraft("");
    setLabelPickerOpen(false);
    labelTriggerRef.current?.focus();
  };

  return (
    <div className="flex h-screen overflow-hidden bg-canvas text-foreground">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-sidebar p-2 md:flex">
        <div className="flex h-9 items-center gap-2 px-1.5">
          <Avatar tone="blue">R</Avatar>
          <span className="text-[13px] font-medium">Relay</span>
          <ChevronDown size={12} className="text-muted-foreground" />
          <Button
            size="icon"
            className="ml-auto size-7"
            title={ui.search}
            aria-label={ui.search}
            onClick={() => setView("search")}
          >
            <Search size={13} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-7 bg-canvas"
            title={ui.createIssue}
            aria-label={ui.createIssue}
            onClick={() => {
              setCreateIssueRequest((current) => current + 1);
              setView("issues");
            }}
          >
            <SquarePen size={14} />
          </Button>
        </div>

        <nav className="mt-2 space-y-0.5">
          <SidebarItem
            icon={<Inbox size={14} />}
            label={ui.inbox}
            active={isInboxView}
            count={
              inboxItems.filter((item) => item.unread && !item.archived).length
            }
            onClick={() => setView("inbox")}
          />
          <SidebarItem
            icon={<LayoutList size={14} />}
            label={ui.issues}
            active={view === "issues" || view === "detail"}
            count={issues.length}
            onClick={() => {
              setCreateIssueRequest(0);
              setView("issues");
            }}
          />
          <SidebarItem
            icon={<Activity size={14} />}
            label={ui.agent}
            active={isAgentView}
            count={data.agents.length}
            onClick={() => setView("agent")}
          />
        </nav>

        <div className="mt-5 px-2 text-[11px] font-medium text-muted-foreground">
          {ui.workspace}
        </div>
        <nav className="mt-1.5 space-y-0.5">
          <SidebarItem
            icon={<Box size={14} />}
            label={ui.projects}
            active={view === "projects" || view === "projectDetail"}
            count={projects.length}
            onClick={() => setView("projects")}
          />
        </nav>

        <div className="mt-5 px-2 text-[11px] font-medium text-muted-foreground">
          {ui.projects}
        </div>
        <nav className="mt-1.5 space-y-0.5">
          {projects.map((project, index) => (
            <SidebarItem
              key={project.id}
              icon={
                <span
                  className={`size-2 rounded-full ${index % 2 ? "bg-cyan-500" : "bg-violet-500"}`}
                />
              }
              label={project.name}
              inset
              onClick={() => openProject(project)}
            />
          ))}
        </nav>

        <div className="mt-auto flex items-center gap-1 border-t border-sidebar-border pt-2">
          <Button
            size="icon"
            className={`size-7 ${
              isSettingsView ? "bg-zinc-200/70 text-foreground" : ""
            }`}
            title={ui.settings}
            aria-label={ui.settings}
            onClick={() => setView("settings")}
          >
            <Settings size={14} />
          </Button>
          <Button
            size="icon"
            className="size-7"
            title={theme === "dark" ? ui.lightMode : ui.darkMode}
            aria-label={theme === "dark" ? ui.lightMode : ui.darkMode}
            onClick={() =>
              setTheme((current) => (current === "dark" ? "light" : "dark"))
            }
          >
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </Button>
          <Button
            size="icon"
            className="size-7"
            title={ui.switchLanguage}
            aria-label={ui.switchLanguage}
            onClick={() =>
              setLanguage((current) => (current === "en" ? "zh" : "en"))
            }
          >
            <Languages size={14} />
          </Button>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 flex h-10 items-center border-b border-border bg-canvas/95 px-3 backdrop-blur">
          {view === "search" ? (
            <div className="flex w-full items-center gap-2">
              <Search size={14} className="text-muted-foreground" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={language === "zh" ? "搜索任务…" : "Search issues…"}
                className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
              {searchQuery && (
                <Button className="h-7" onClick={() => setSearchQuery("")}>
                  Clear
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-1 text-xs">
                {isAgentView ? (
                  <Bot size={14} className="text-blue-500" />
                ) : isInboxView ? (
                  <Inbox size={14} className="text-blue-500" />
                ) : isSettingsView ? (
                  <Settings size={14} className="text-blue-500" />
                ) : isProjectView ? (
                  <Folder size={14} className="text-blue-500" />
                ) : (
                  <Box size={14} className="text-blue-500" />
                )}
                <span className="font-medium">Relay</span>
                <ChevronRight size={13} className="text-muted-foreground" />
                <Button
                  className="h-7 px-1 font-normal text-foreground"
                  onClick={() =>
                    setView(
                      isInboxView
                        ? "inbox"
                        : isAgentView
                          ? "agent"
                          : isSettingsView
                            ? "settings"
                            : isProjectView
                              ? "projects"
                              : "issues",
                    )
                  }
                >
                  {isInboxView
                    ? ui.inbox
                    : isAgentView
                      ? ui.agent
                      : isSettingsView
                        ? ui.settings
                        : isProjectView
                          ? ui.projects
                          : ui.issues}
                </Button>
                {view === "detail" && (
                  <>
                    <ChevronRight size={13} className="text-muted-foreground" />
                    <span className="truncate font-medium">
                      {selectedIssue.id}
                    </span>
                    <span className="hidden max-w-48 truncate sm:inline">
                      {selectedIssue.title}
                    </span>
                  </>
                )}
                {view === "projectDetail" && selectedProject && (
                  <>
                    <ChevronRight size={13} className="text-muted-foreground" />
                    <span className="truncate font-medium">
                      {selectedProject.name}
                    </span>
                    <Button size="icon" className="size-7">
                      <MoreHorizontal size={15} />
                    </Button>
                  </>
                )}
              </div>
              {view === "detail" && (
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-7"
                    title="Copy issue link"
                    onClick={() =>
                      void navigator.clipboard.writeText(location.href)
                    }
                  >
                    <Copy size={13} />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-7"
                    aria-label="Issue actions"
                    onClick={() => setControlsOpen(!controlsOpen)}
                  >
                    <MoreHorizontal size={14} />
                  </Button>
                  {controlsOpen && (
                    <div className="absolute right-3 top-10 z-40 min-w-44 rounded-md border border-border bg-card p-1 shadow-lg">
                      {(
                        [
                          ["start", "Start"],
                          ["pause", "Pause"],
                          ["resume", "Resume"],
                          ["stop", "Stop and correct"],
                          ["reopen", "Reopen"],
                        ] as const
                      ).map(([command, label]) => (
                        <Button
                          key={command}
                          className="w-full justify-start"
                          disabled={
                            busy ||
                            (command === "reopen" &&
                              selectedIssue.status !== "Done")
                          }
                          onClick={async () => {
                            const text =
                              command === "stop" || command === "reopen"
                                ? window.prompt(label)
                                : undefined;
                            if (text === null) return;
                            const r = await action("issue.control", {
                              issueId: selectedIssue.uid,
                              command,
                              text,
                            });
                            if (r) setControlsOpen(false);
                          }}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </header>

        {view === "search" ? (
          <SearchPage
            query={searchQuery}
            issues={issues}
            onOpenIssue={openIssue}
          />
        ) : view === "inbox" ? (
          <InboxPage
            items={inboxItems}
            onRead={readInboxItem}
            onArchive={archiveInboxItem}
            onOpenIssue={openIssueById}
          />
        ) : view === "agent" ? (
          <AgentPage />
        ) : view === "issues" ? (
          <IssuesList
            key={`issues-${createIssueRequest}`}
            issues={issues}
            onOpen={openIssue}
            onCreate={createIssue}
            startCreating={createIssueRequest > 0}
            onCreateDismiss={() => setCreateIssueRequest(0)}
          />
        ) : view === "settings" ? (
          <SettingsPage />
        ) : view === "projects" ? (
          <ProjectsList
            projects={projects}
            onOpen={openProject}
            onCreate={createProject}
          />
        ) : view === "projectDetail" && selectedProject ? (
          <ProjectDetail
            key={selectedProject.id}
            project={selectedProject}
            onAddWorktree={addWorktree}
            onUpdateSpec={updateSpec}
          />
        ) : (
          <main className="mx-auto grid max-w-6xl grid-cols-1 gap-12 px-5 py-8 md:px-10 lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-16 lg:py-10">
            <section className="min-w-0">
              <div className="text-base font-semibold tracking-tight">
                {selectedIssue.title}
              </div>
              <div className="mt-3 max-w-2xl text-[13px] leading-6 text-muted-foreground">
                {selectedIssue.description}
              </div>

              <div className="mt-12 flex items-center gap-1">
                <Button
                  size="icon"
                  className="size-7"
                  aria-label="Add comment"
                  onClick={() => commentRef.current?.focus()}
                >
                  <MessageSquare size={14} />
                </Button>
                <input {...upload.inputProps} />
                <Button
                  size="icon"
                  className="size-7"
                  aria-label="Attach files"
                  onClick={upload.choose}
                >
                  <Paperclip size={14} />
                </Button>
              </div>

              <div className="mt-6 border-t border-border pt-5">
                <div className="mb-3 flex items-center">
                  <span className="text-sm font-semibold">Activity</span>
                </div>

                <div className="space-y-2">
                  <div className="flex flex-col-reverse gap-2">
                    {groupActivity(data, selectedIssue.uid).map((entry) => (
                      <ActivityRow
                        key={entry.id}
                        entry={entry}
                        language={language}
                      />
                    ))}
                  </div>
                  {data.comments
                    .filter((c) => c.issueId === selectedIssue.uid)
                    .map((c) => (
                      <Comment
                        key={c.id}
                        avatar="H"
                        name="Human"
                        time={time(c.createdAt)}
                      >
                        {c.text}
                      </Comment>
                    ))}

                  <div className="overflow-hidden rounded-lg border border-border bg-card shadow-xs">
                    <div className="flex items-center gap-2 px-4 pt-3.5">
                      <Avatar tone="dark">H</Avatar>
                      <span className="text-xs font-medium">Human</span>
                    </div>
                    <textarea
                      ref={commentRef}
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="Leave a comment…"
                      className="min-h-20 w-full resize-none bg-transparent px-4 py-3 text-[13px] outline-none placeholder:text-muted-foreground"
                    />
                    <div className="flex h-10 items-center border-t border-border px-3">
                      <Button
                        size="icon"
                        className="size-7"
                        aria-label="Attach comment files"
                        onClick={upload.choose}
                      >
                        <Paperclip size={13} />
                      </Button>
                      <Button
                        variant="default"
                        size="icon"
                        className="ml-auto size-7"
                        disabled={!comment.trim() || busy}
                        onClick={sendComment}
                      >
                        <ArrowUp size={13} />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <aside className="min-w-0 lg:pt-8">
              <div className="text-xs font-medium text-muted-foreground">
                Properties
              </div>
              <div className="mt-3 space-y-0.5">
                <Property icon={<CircleDot size={15} />}>
                  <span>{selectedIssue.status}</span>
                </Property>
                <PriorityPicker
                  key={selectedIssue.id}
                  priority={selectedIssue.priority ?? 0}
                  onChange={(priority) => void updateIssue({ priority })}
                />
                <Property icon={<UserRound size={14} />}>
                  <span>Human</span>
                </Property>
              </div>

              <div className="mt-6 px-1.5 text-[13px] font-medium text-zinc-600 dark:text-muted-foreground">
                Labels
              </div>
              <div
                ref={labelPickerRef}
                className="relative mt-3"
                onBlur={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  )
                    setLabelPickerOpen(false);
                }}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  {issueLabels.map((label) => (
                    <button
                      key={label}
                      type="button"
                      className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-[#dedede] bg-transparent px-2 text-[12px]! leading-5 font-normal text-zinc-700 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring dark:border-border dark:text-foreground"
                      aria-label={`Edit label ${label}`}
                      onClick={() => setLabelPickerOpen(true)}
                    >
                      <span
                        className={`size-[9px] shrink-0 rounded-full ${
                          availableLabels.find((item) => item.name === label)
                            ?.color ?? "bg-emerald-400"
                        }`}
                      />
                      {label}
                    </button>
                  ))}
                  <button
                    ref={labelTriggerRef}
                    type="button"
                    className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-full text-zinc-600 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring dark:text-muted-foreground"
                    aria-label="Add labels"
                    aria-expanded={labelPickerOpen}
                    onClick={() => setLabelPickerOpen((current) => !current)}
                  >
                    <Plus size={15} strokeWidth={2} />
                  </button>
                </div>

                {labelPickerOpen && (
                  <div className="absolute left-0 top-9 z-20 w-64 overflow-hidden rounded-xl border border-border bg-card shadow-xl">
                    <div className="border-b border-border p-2">
                      <input
                        autoFocus
                        value={labelDraft}
                        onChange={(event) => setLabelDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            !event.nativeEvent.isComposing
                          ) {
                            event.preventDefault();
                            addIssueLabel();
                          }
                        }}
                        placeholder="Change or add labels…"
                        className="h-8 w-full bg-transparent px-1 text-[13px] outline-none placeholder:text-muted-foreground"
                      />
                    </div>
                    <div className="max-h-60 overflow-y-auto p-1.5">
                      {availableLabels
                        .filter((label) =>
                          label.name
                            .toLowerCase()
                            .includes(labelDraft.toLowerCase()),
                        )
                        .map((label) => {
                          const selected = issueLabels.includes(label.name);
                          return (
                            <Button
                              key={label.name}
                              className="h-10 w-full justify-start px-2 text-[13px]! font-normal"
                              onClick={() => {
                                setIssueLabels((current) =>
                                  selected
                                    ? current.filter(
                                        (item) => item !== label.name,
                                      )
                                    : [...current, label.name],
                                );
                                setLabelPickerOpen(false);
                                labelTriggerRef.current?.focus();
                              }}
                            >
                              <span
                                className={`flex size-4 items-center justify-center rounded border ${
                                  selected
                                    ? "border-violet-500 bg-violet-500 text-white"
                                    : "border-border"
                                }`}
                              >
                                {selected && <Check size={11} />}
                              </span>
                              <span
                                className={`size-2 rounded-full ${label.color}`}
                              />
                              {label.name}
                            </Button>
                          );
                        })}
                      {labelDraft.trim() &&
                        !availableLabels.some(
                          (label) =>
                            label.name.toLowerCase() ===
                            labelDraft.trim().toLowerCase(),
                        ) && (
                          <Button
                            className="h-10 w-full justify-start px-2 text-[13px]! font-normal"
                            onClick={addIssueLabel}
                          >
                            <Plus size={14} />
                            Create “{labelDraft.trim()}”
                          </Button>
                        )}
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-6 text-xs font-medium text-muted-foreground">
                Assignments
              </div>
              <div className="mt-3 space-y-3">
                {selectedIssueBindings.map((binding) => {
                  const project = projects.find(
                    (item) => item.id === binding.projectId,
                  );
                  const worktree = project?.worktrees.find(
                    (item) => item.id === binding.worktreeId,
                  );
                  return (
                    <Property key={binding.id} icon={<Box size={14} />}>
                      <div>
                        <div className="flex items-center">
                          <span>{project?.name ?? "Unknown project"}</span>
                          <span
                            className={`ml-auto text-[11px] ${binding.status === "Waiting" ? "text-amber-600" : "text-emerald-600"}`}
                          >
                            {binding.status}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <GitBranch size={11} />
                          <span className="truncate font-mono">
                            {worktree?.branch ?? "Unknown worktree"}
                          </span>
                          <Bot size={11} className="ml-1" />
                          {binding.agent}
                        </div>
                        <div
                          className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground"
                          title={binding.routingDescription}
                        >
                          {binding.routingDescription}
                        </div>
                      </div>
                    </Property>
                  );
                })}
                {!selectedIssueBindings.length && (
                  <div className="text-[11px] text-muted-foreground">
                    No assignments
                  </div>
                )}
                <Button
                  className="px-0 text-muted-foreground"
                  onClick={() => setBindAgentOpen(true)}
                >
                  <Plus size={13} />
                  Bind agent
                </Button>
              </div>

              <div className="mt-6 text-xs font-medium text-muted-foreground">
                Created
              </div>
              <div className="mt-3">
                <Property icon={<UserRound size={14} />}>
                  <span className="text-muted-foreground">
                    {time(rawIssue?.createdAt || "")}
                  </span>
                </Property>
              </div>
            </aside>
          </main>
        )}
      </div>
      {bindAgentOpen && (
        <BindAgentDialog
          projects={projects}
          issue={selectedIssue}
          onClose={() => setBindAgentOpen(false)}
          onBind={bindAgentToIssue}
        />
      )}
    </div>
  );
}

export default function App() {
  const value = useData();
  const action: typeof value.action = async (type, payload) => {
    try {
      return await value.action(type, payload);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  };
  return (
    <Backend.Provider value={{ ...value, action }}>
      <RelayView />
    </Backend.Provider>
  );
}

function useUpload(issueId?: string) {
  const { action } = useBackend();
  const ref = useRef<HTMLInputElement>(null);
  return {
    choose: () => ref.current?.click(),
    inputProps: {
      ref,
      type: "file",
      multiple: true,
      className: "hidden",
      onChange: async (e: React.ChangeEvent<HTMLInputElement>) => {
        try {
          if (!issueId) return;
          const files = await filesPayload(Array.from(e.target.files || []));
          for (const f of files)
            await action("attachment.create", { issueId, ...f });
          e.target.value = "";
        } catch (error) {
          window.alert(String(error));
        }
      },
    },
  };
}
