import {
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleDot,
  CodeXml,
  Copy,
  Ellipsis,
  Folder,
  SquarePen,
  Plus,
} from "lucide-react";

const icons = {
  back: ArrowLeft,
  send: ArrowUp,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  issue: CircleDot,
  nav: CircleDot,
  code: CodeXml,
  copy: Copy,
  more: Ellipsis,
  folder: Folder,
  edit: SquarePen,
  plus: Plus,
};

export function Icon({ name }: { name: keyof typeof icons }) {
  const Component = icons[name];
  return (
    <span className={`icon icon-${name}`} aria-hidden="true">
      <Component size={16} strokeWidth={2} focusable="false" />
    </span>
  );
}
