import CopyButton from "./CopyButton";

interface CodeBlockProps {
  code: string;
  language?: string;
  title?: string;
  className?: string;
}

export default function CodeBlock({ code, language = "bash", title, className = "" }: CodeBlockProps) {
  const trimmed = code.trim();

  return (
    <div className={`rounded-lg border border-slate-800 bg-slate-900 overflow-hidden text-slate-100 ${className}`}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800/80 bg-slate-950/60 text-xs font-mono text-slate-400">
        <span className="truncate">{title || language}</span>
        <CopyButton text={trimmed} />
      </div>
      <pre className="p-3.5 text-xs sm:text-sm font-mono leading-relaxed overflow-x-auto text-slate-200">
        <code>{trimmed}</code>
      </pre>
    </div>
  );
}
